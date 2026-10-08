-- AdsCords - portefeuille de crédits bonus et commande .add_bonus.
-- À exécuter APRÈS 004_campaign_duration_and_earnings.sql.

create table if not exists public.bonus_wallets (
  user_discord_id text primary key check (user_discord_id ~ '^[0-9]{15,25}$'),
  balance_milli_cents bigint not null default 0 check (balance_milli_cents >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.bonus_wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_discord_id text not null references public.bonus_wallets(user_discord_id) on delete cascade,
  delta_milli_cents bigint not null check (delta_milli_cents <> 0),
  reason text not null check (reason in ('manual_credit', 'server_bonus_reward')),
  source_earning_id uuid unique references public.server_earnings(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists bonus_wallet_transactions_user_created_idx
  on public.bonus_wallet_transactions (user_discord_id, created_at desc);

drop trigger if exists bonus_wallets_updated_at on public.bonus_wallets;
create trigger bonus_wallets_updated_at
before update on public.bonus_wallets
for each row execute function public.set_updated_at();

-- Chaque récompense bonus de serveur devient automatiquement utilisable dans le portefeuille
-- de son propriétaire. Les campagnes en euros ne créent aucun crédit bonus.
create or replace function public.credit_bonus_from_server_earning()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.reward_type <> 'bonus' or new.server_share_milli_cents <= 0 then
    return new;
  end if;

  insert into public.bonus_wallets (user_discord_id, balance_milli_cents)
  values (new.owner_discord_id, new.server_share_milli_cents)
  on conflict (user_discord_id) do update
  set balance_milli_cents = public.bonus_wallets.balance_milli_cents + excluded.balance_milli_cents;

  insert into public.bonus_wallet_transactions (
    user_discord_id, delta_milli_cents, reason, source_earning_id
  )
  values (new.owner_discord_id, new.server_share_milli_cents, 'server_bonus_reward', new.id)
  on conflict (source_earning_id) do nothing;
  return new;
end;
$$;

drop trigger if exists server_earnings_bonus_wallet on public.server_earnings;
create trigger server_earnings_bonus_wallet
after insert on public.server_earnings
for each row execute function public.credit_bonus_from_server_earning();

-- Les crédits bonus de campagnes éventuellement enregistrés entre 004 et 005 sont repris une fois.
-- Les portefeuilles doivent exister avant l'insertion de l'historique (clé étrangère).
insert into public.bonus_wallets (user_discord_id, balance_milli_cents)
select distinct owner_discord_id, 0
from public.server_earnings
where reward_type = 'bonus' and server_share_milli_cents > 0
on conflict (user_discord_id) do nothing;

with inserted as (
  insert into public.bonus_wallet_transactions (
    user_discord_id, delta_milli_cents, reason, source_earning_id
  )
  select owner_discord_id, server_share_milli_cents, 'server_bonus_reward', id
  from public.server_earnings
  where reward_type = 'bonus' and server_share_milli_cents > 0
  on conflict (source_earning_id) do nothing
  returning user_discord_id, delta_milli_cents
)
insert into public.bonus_wallets (user_discord_id, balance_milli_cents)
select user_discord_id, sum(delta_milli_cents)
from inserted
group by user_discord_id
on conflict (user_discord_id) do update
set balance_milli_cents = public.bonus_wallets.balance_milli_cents + excluded.balance_milli_cents;

-- Crédit manuel : seul le bot, via la clé service_role, peut appeler cette RPC.
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

alter table public.bonus_wallets enable row level security;
alter table public.bonus_wallet_transactions enable row level security;
revoke all on table public.bonus_wallets, public.bonus_wallet_transactions from anon, authenticated;
revoke all on function public.credit_bonus_wallet(text, bigint, text) from public, anon, authenticated;
grant execute on function public.credit_bonus_wallet(text, bigint, text) to service_role;
