-- AdsCords - campagnes à durée limitée, rythme de valeur sur 3 jours et gains des serveurs.
-- À exécuter APRÈS 001_initial_schema.sql, 002_dynamic_click_guard.sql et 003_campaign_media.sql.

-- Une campagne peut être en euros réels ou en crédits bonus. Les crédits bonus
-- servent exclusivement de récompense interne et ne représentent pas un versement en euros.
alter table public.ads
  add column if not exists reward_type text not null default 'cash'
    check (reward_type in ('cash', 'bonus')),
  add column if not exists duration_days integer not null default 1
    check (duration_days between 1 and 365),
  add column if not exists starts_at timestamptz not null default now(),
  add column if not exists ends_at timestamptz;

-- Les anciennes campagnes restent consultables une journée après l'installation.
update public.ads
set
  starts_at = coalesce(starts_at, created_at),
  ends_at = coalesce(ends_at, coalesce(starts_at, created_at) + make_interval(days => duration_days));

alter table public.ads
  alter column ends_at set not null;

create index if not exists ads_ends_at_idx on public.ads (ends_at);

-- L'identité du propriétaire est enregistrée au moment où le serveur est configuré
-- et resynchronisée par le bot. Elle permet d'attribuer les gains au bon propriétaire.
alter table public.guild_settings
  add column if not exists owner_discord_id text;

create index if not exists guild_settings_owner_discord_id_idx
  on public.guild_settings (owner_discord_id);

-- Le premier clic valorisé n'est désormais à 10 CT qu'une fois par fenêtre de 3 jours.
alter table public.click_guard_settings
  add column if not exists first_value_cooldown_days integer not null default 3
    check (first_value_cooldown_days between 1 and 30);

-- Journal financier immuable : il survit à .clear_pubs, contrairement aux statistiques
-- d'une campagne supprimée. Un milli-cent évite de perdre les 30 % / 70 % sur les petits clics.
create table if not exists public.server_earnings (
  id uuid primary key default gen_random_uuid(),
  ad_id uuid not null,
  visitor_id text not null,
  guild_id text not null,
  owner_discord_id text not null,
  reward_type text not null check (reward_type in ('cash', 'bonus')),
  charged_cents integer not null check (charged_cents > 0),
  server_share_milli_cents bigint not null check (server_share_milli_cents >= 0),
  platform_share_milli_cents bigint not null check (platform_share_milli_cents >= 0),
  earned_at timestamptz not null default now(),
  unique (ad_id, visitor_id)
);

create index if not exists server_earnings_owner_earned_at_idx
  on public.server_earnings (owner_discord_id, earned_at desc);
create index if not exists server_earnings_guild_earned_at_idx
  on public.server_earnings (guild_id, earned_at desc);

-- Remplace le calcul quotidien par une fenêtre glissante de 3 jours et applique :
--   * la durée de vie de la campagne ;
--   * son budget journalier exact (reste réparti sur les premiers jours) ;
--   * 30 % de gains réels au propriétaire du serveur pour une campagne cash ;
--   * 70 % de crédits bonus au propriétaire pour une campagne bonus, les 30 % restants brûlés.
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
  v_campaign_start_day date;
  v_campaign_day integer;
  v_daily_budget integer;
  v_spent_today integer;
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

  if v_ad.ends_at <= now() then
    update public.ads set is_active = false where id = v_ad.id;
    return query select 'unavailable'::text, null::text, 0, v_ad.credits_remaining_cents, false, 'campaign_expired'::text;
    return;
  end if;

  -- La redirection gratuite n'est admise que tant que la campagne est réellement en ligne.
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

  insert into public.click_profiles (visitor_id)
  values (p_user_id)
  on conflict (visitor_id) do nothing;

  select * into v_profile
  from public.click_profiles
  where visitor_id = p_user_id
  for update;

  v_today := (now() at time zone 'Europe/Paris')::date;
  v_campaign_start_day := (v_ad.starts_at at time zone 'Europe/Paris')::date;
  v_campaign_day := (v_today - v_campaign_start_day) + 1;

  if v_campaign_day < 1 or v_campaign_day > v_ad.duration_days then
    update public.ads set is_active = false where id = v_ad.id;
    return query select 'unavailable'::text, null::text, 0, v_ad.credits_remaining_cents, false, 'campaign_expired'::text;
    return;
  end if;

  -- Répartition entière exacte : exemple 10 CT / 3 jours = 4, 3, 3 CT.
  v_daily_budget := (v_ad.initial_credits_cents / v_ad.duration_days)
    + case when v_campaign_day <= (v_ad.initial_credits_cents % v_ad.duration_days) then 1 else 0 end;

  v_is_currently_suspended := v_profile.suspended_until is not null and v_profile.suspended_until > now();
  if v_is_currently_suspended then
    v_charge := 0;
    v_reason := 'suspended';
  elsif exists (
    select 1
    from public.ad_clicks
    where user_id = p_user_id
      and charged_cents > 0
      -- Fenêtre calendaire Paris : un clic le 1er redonne 10 CT le 4, quelle que soit l'heure.
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
    select coalesce(sum(charged_cents), 0)::integer into v_spent_today
    from public.ad_clicks
    where ad_id = p_ad_id
      and (clicked_at at time zone 'Europe/Paris')::date = v_today;

    if v_spent_today + v_charge > v_daily_budget then
      return query select
        'unavailable'::text,
        null::text,
        0,
        v_ad.credits_remaining_cents,
        v_ad.is_active,
        'daily_budget_exhausted'::text;
      return;
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

  -- Les clics sans valeur d'un visiteur suspendu restent dans l'historique.
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

alter table public.server_earnings enable row level security;
revoke all on table public.server_earnings from anon, authenticated;
revoke all on function public.register_ad_click(uuid, text, text) from public, anon, authenticated;
grant execute on function public.register_ad_click(uuid, text, text) to service_role;
