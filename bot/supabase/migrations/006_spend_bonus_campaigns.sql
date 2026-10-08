-- AdsCords - débit atomique du portefeuille pour les campagnes en crédits bonus.
-- À exécuter APRÈS 005_bonus_wallets.sql.

alter table public.bonus_wallet_transactions
  drop constraint if exists bonus_wallet_transactions_reason_check;
alter table public.bonus_wallet_transactions
  add constraint bonus_wallet_transactions_reason_check
  check (reason in ('manual_credit', 'server_bonus_reward', 'campaign_spend'));

-- Crée la campagne bonus et débite son budget dans la même transaction SQL.
-- Une campagne ne peut donc jamais être publiée avec un portefeuille insuffisant.
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
  if p_duration_days < 1 or p_duration_days > 365 then
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
    owner_discord_id,
    destination_url,
    description,
    media_url,
    use_embed,
    reward_type,
    duration_days,
    starts_at,
    ends_at,
    initial_credits_cents,
    credits_remaining_cents,
    click_cost_cents,
    is_active
  )
  values (
    p_owner_discord_id,
    p_destination_url,
    p_description,
    nullif(p_media_url, ''),
    p_use_embed,
    'bonus',
    p_duration_days,
    now(),
    now() + p_duration_days * interval '1 day',
    p_credits_cents,
    p_credits_cents,
    p_click_cost_cents,
    p_credits_cents >= p_click_cost_cents
  )
  returning * into v_ad;

  return next v_ad;
  return;
end;
$$;

revoke all on function public.create_bonus_campaign(text, text, text, text, boolean, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.create_bonus_campaign(text, text, text, text, boolean, integer, integer, integer) to service_role;
