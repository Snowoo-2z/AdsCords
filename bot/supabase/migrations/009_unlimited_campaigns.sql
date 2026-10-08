-- AdsCords - campagnes sans durée et débit bonus explicite.
-- À exécuter APRÈS 008_campaign_delivery_cleanup.sql.

alter table public.ads
  drop constraint if exists ads_duration_days_check;
alter table public.ads
  add constraint ads_duration_days_check check (duration_days between 0 and 365),
  alter column ends_at drop not null;

-- Corrige également la validation des IDs pour les installations qui avaient déjà exécuté 005.
alter table public.bonus_wallets
  drop constraint if exists bonus_wallets_user_discord_id_check;
alter table public.bonus_wallets
  add constraint bonus_wallets_user_discord_id_check check (user_discord_id ~ '^[0-9]{15,25}$');

create or replace function public.credit_bonus_wallet(
  p_user_discord_id text,
  p_amount_milli_cents bigint,
  p_reason text default 'manual_credit'
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance bigint;
begin
  if p_user_discord_id !~ '^[0-9]{15,25}$' then
    raise exception 'ID Discord invalide';
  end if;
  if p_amount_milli_cents <= 0 then
    raise exception 'Le crédit bonus doit être strictement positif';
  end if;
  if p_reason <> 'manual_credit' then
    raise exception 'Motif de crédit manuel invalide';
  end if;

  insert into public.bonus_wallets (user_discord_id, balance_milli_cents)
  values (p_user_discord_id, p_amount_milli_cents)
  on conflict (user_discord_id) do update
  set balance_milli_cents = public.bonus_wallets.balance_milli_cents + excluded.balance_milli_cents
  returning balance_milli_cents into v_balance;

  insert into public.bonus_wallet_transactions (user_discord_id, delta_milli_cents, reason)
  values (p_user_discord_id, p_amount_milli_cents, p_reason);
  return v_balance;
end;
$$;

revoke all on function public.credit_bonus_wallet(text, bigint, text) from public, anon, authenticated;
grant execute on function public.credit_bonus_wallet(text, bigint, text) to service_role;

-- La création bonus retire le budget du portefeuille dans la même transaction.
create or replace function public.create_bonus_campaign(
  p_owner_discord_id text,
  p_destination_url text,
  p_description text,
  p_media_url text,
  p_use_embed boolean,
  p_duration_days integer,
  p_credits_cents integer,
  p_click_cost_cents integer
)
returns setof public.ads
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance bigint;
  v_ad public.ads%rowtype;
  v_debit_milli_cents bigint;
begin
  if p_owner_discord_id !~ '^[0-9]{15,25}$' then
    raise exception 'ID Discord propriétaire invalide';
  end if;
  if p_duration_days < 0 or p_duration_days > 365 then
    raise exception 'Durée de campagne invalide';
  end if;
  if p_credits_cents <= 0 or p_click_cost_cents <= 0 then
    raise exception 'Budget de campagne invalide';
  end if;

  v_debit_milli_cents := p_credits_cents::bigint * 1000;
  select balance_milli_cents into v_balance
  from public.bonus_wallets
  where user_discord_id = p_owner_discord_id
  for update;
  if not found or v_balance < v_debit_milli_cents then
    raise exception 'BONUS_BALANCE_INSUFFICIENT';
  end if;

  update public.bonus_wallets
  set balance_milli_cents = balance_milli_cents - v_debit_milli_cents
  where user_discord_id = p_owner_discord_id;
  insert into public.bonus_wallet_transactions (user_discord_id, delta_milli_cents, reason)
  values (p_owner_discord_id, -v_debit_milli_cents, 'campaign_spend');

  insert into public.ads (
    owner_discord_id, destination_url, description, media_url, use_embed, reward_type,
    duration_days, starts_at, ends_at, initial_credits_cents, credits_remaining_cents,
    click_cost_cents, is_active
  ) values (
    p_owner_discord_id, p_destination_url, p_description, nullif(p_media_url, ''), p_use_embed, 'bonus',
    p_duration_days, now(), case when p_duration_days = 0 then null else now() + p_duration_days * interval '1 day' end,
    p_credits_cents, p_credits_cents, p_click_cost_cents, p_credits_cents >= p_click_cost_cents
  )
  returning * into v_ad;

  return next v_ad;
  return;
end;
$$;

revoke all on function public.create_bonus_campaign(text, text, text, text, boolean, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.create_bonus_campaign(text, text, text, text, boolean, integer, integer, integer) to service_role;

drop function if exists public.register_ad_click(uuid, text, text);
create function public.register_ad_click(
  p_ad_id uuid,
  p_user_id text,
  p_guild_id text
)
returns table (
  status text,
  destination_url text,
  charged_cents integer,
  credits_remaining_cents integer,
  is_active boolean,
  pricing_reason text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ad public.ads%rowtype;
  v_profile public.click_profiles%rowtype;
  v_settings public.click_guard_settings%rowtype;
  v_charge integer;
  v_reason text;
  v_today date;
  v_campaign_day integer;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_daily_budget integer;
  v_spent_period integer;
  v_suspicious_days integer;
  v_is_currently_suspended boolean;
  v_guild_owner text;
  v_server_share_milli bigint;
  v_platform_share_milli bigint;
begin
  select * into v_ad
  from public.ads
  where id = p_ad_id
  for update;

  if not found then
    return query select 'not_found'::text, null::text, 0, null::integer, null::boolean, 'not_found'::text;
    return;
  end if;

  if not v_ad.is_active then
    return query select 'unavailable'::text, null::text, 0, v_ad.credits_remaining_cents, false, 'campaign_inactive'::text;
    return;
  end if;

  if v_ad.ends_at is not null and v_ad.ends_at <= now() then
    update public.ads set is_active = false where id = v_ad.id;
    return query select 'unavailable'::text, null::text, 0, v_ad.credits_remaining_cents, false, 'campaign_expired'::text;
    return;
  end if;

  -- La redirection gratuite ne reste possible que durant la durée effective de la campagne.
  if exists (select 1 from public.ad_clicks where ad_id = p_ad_id and user_id = p_user_id) then
    return query select
      'already_clicked'::text,
      v_ad.destination_url,
      0,
      v_ad.credits_remaining_cents,
      v_ad.is_active,
      'already_clicked'::text;
    return;
  end if;

  select * into v_settings from public.click_guard_settings where id = true;
  if not found then
    raise exception 'Les réglages click_guard_settings sont absents';
  end if;

  -- duration_days = 0 signifie une campagne sans durée : tout le budget reste consommable jusqu'à épuisement.
  if v_ad.duration_days > 0 then
    v_campaign_day := floor(extract(epoch from (now() - v_ad.starts_at)) / 86400)::integer + 1;
    if v_campaign_day < 1 or v_campaign_day > v_ad.duration_days then
      update public.ads set is_active = false where id = v_ad.id;
      return query select 'unavailable'::text, null::text, 0, v_ad.credits_remaining_cents, false, 'campaign_expired'::text;
      return;
    end if;
    v_period_start := v_ad.starts_at + (v_campaign_day - 1) * interval '1 day';
    v_period_end := v_period_start + interval '1 day';
    v_daily_budget := (v_ad.initial_credits_cents / v_ad.duration_days)
      + case when v_campaign_day <= (v_ad.initial_credits_cents % v_ad.duration_days) then 1 else 0 end;
  end if;

  insert into public.click_profiles (visitor_id)
  values (p_user_id)
  on conflict (visitor_id) do nothing;

  select * into v_profile
  from public.click_profiles
  where visitor_id = p_user_id
  for update;

  v_today := (now() at time zone 'Europe/Paris')::date;
  v_is_currently_suspended := v_profile.suspended_until is not null and v_profile.suspended_until > now();
  if v_is_currently_suspended then
    v_charge := 0;
    v_reason := 'suspended';
  elsif exists (
    select 1
    from public.ad_clicks
    where user_id = p_user_id
      and charged_cents > 0
      and (clicked_at at time zone 'Europe/Paris')::date >= v_today - (v_settings.first_value_cooldown_days - 1)
  ) then
    v_charge := floor(
      random() * (v_settings.repeat_click_max_cents - v_settings.repeat_click_min_cents + 1)
    )::integer + v_settings.repeat_click_min_cents;
    v_reason := 'repeat_3day';
  else
    v_charge := v_settings.first_daily_click_cents;
    v_reason := 'first_3day';
  end if;

  if v_charge > 0 then
    if v_ad.duration_days > 0 then
      select coalesce(sum(charged_cents), 0)::integer into v_spent_period
      from public.ad_clicks
      where ad_id = p_ad_id
        and clicked_at >= v_period_start
        and clicked_at < v_period_end;

      if v_spent_period + v_charge > v_daily_budget then
        return query select 'unavailable'::text, null::text, 0, v_ad.credits_remaining_cents, v_ad.is_active, 'daily_budget_exhausted'::text;
        return;
      end if;
    end if;

    if v_ad.credits_remaining_cents < v_charge then
      update public.ads set is_active = false where id = v_ad.id;
      return query select 'unavailable'::text, null::text, 0, v_ad.credits_remaining_cents, false, 'insufficient_budget'::text;
      return;
    end if;
  end if;

  insert into public.ad_clicks (ad_id, user_id, guild_id, charged_cents, pricing_reason)
  values (p_ad_id, p_user_id, p_guild_id, v_charge, v_reason);

  if v_charge > 0 then
    update public.ads
    set
      credits_remaining_cents = v_ad.credits_remaining_cents - v_charge,
      is_active = (v_ad.credits_remaining_cents - v_charge) >= v_settings.repeat_click_min_cents
    where id = v_ad.id
    returning * into v_ad;

    select owner_discord_id into v_guild_owner
    from public.guild_settings
    where guild_id = p_guild_id;

    if v_guild_owner is not null and length(trim(v_guild_owner)) > 0 then
      if v_ad.reward_type = 'bonus' then
        v_server_share_milli := v_charge::bigint * 700;
        v_platform_share_milli := 0;
      else
        v_server_share_milli := v_charge::bigint * 300;
        v_platform_share_milli := v_charge::bigint * 700;
      end if;

      insert into public.server_earnings (
        ad_id, visitor_id, guild_id, owner_discord_id, reward_type, charged_cents,
        server_share_milli_cents, platform_share_milli_cents
      )
      values (
        p_ad_id, p_user_id, p_guild_id, v_guild_owner, v_ad.reward_type, v_charge,
        v_server_share_milli, v_platform_share_milli
      )
      on conflict (ad_id, visitor_id) do nothing;
    end if;
  end if;

  if not v_is_currently_suspended then
    select count(*) into v_suspicious_days
    from (
      select (clicked_at at time zone 'Europe/Paris')::date as click_day
      from public.ad_clicks
      where user_id = p_user_id
        and (clicked_at at time zone 'Europe/Paris')::date >= v_today - (v_settings.history_window_days - 1)
      group by (clicked_at at time zone 'Europe/Paris')::date
      having count(*) >= v_settings.suspicious_clicks_per_day
    ) as suspicious_days;

    if v_suspicious_days >= v_settings.suspicious_days_required then
      update public.click_profiles
      set
        suspended_until = now() + make_interval(days => v_settings.suspension_days),
        suspension_count = suspension_count + 1,
        last_suspension_at = now()
      where visitor_id = p_user_id;

      update public.ad_clicks
      set pricing_reason = v_reason || '_flagged'
      where ad_id = p_ad_id and user_id = p_user_id;
      v_reason := v_reason || '_flagged';
    end if;
  end if;

  return query select
    'charged'::text,
    v_ad.destination_url,
    v_charge,
    v_ad.credits_remaining_cents,
    v_ad.is_active,
    v_reason;
end;
$$;

revoke all on function public.register_ad_click(uuid, text, text) from public, anon, authenticated;
grant execute on function public.register_ad_click(uuid, text, text) to service_role;

-- Force PostgREST à recharger immédiatement les signatures RPC après les CREATE OR REPLACE.
notify pgrst, 'reload schema';
