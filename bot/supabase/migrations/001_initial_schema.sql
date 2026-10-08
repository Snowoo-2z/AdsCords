-- AdsCords - schéma Supabase initial
-- À exécuter dans Supabase > SQL Editor, ou via `supabase db push`.

create extension if not exists pgcrypto;

create table if not exists public.guild_settings (
  guild_id text primary key,
  ad_channel_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ads (
  id uuid primary key default gen_random_uuid(),
  owner_discord_id text not null,
  destination_url text not null check (destination_url ~* '^https?://'),
  description text not null check (char_length(description) between 1 and 1000),
  initial_credits_cents integer not null check (initial_credits_cents > 0),
  credits_remaining_cents integer not null check (credits_remaining_cents >= 0),
  click_cost_cents integer not null default 15 check (click_cost_cents > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (credits_remaining_cents <= initial_credits_cents)
);

create table if not exists public.ad_deliveries (
  id uuid primary key default gen_random_uuid(),
  ad_id uuid not null references public.ads(id) on delete cascade,
  guild_id text not null,
  channel_id text not null,
  message_id text not null,
  delivered_at timestamptz not null default now(),
  unique (ad_id, guild_id)
);

create table if not exists public.ad_clicks (
  ad_id uuid not null references public.ads(id) on delete cascade,
  user_id text not null,
  guild_id text not null,
  clicked_at timestamptz not null default now(),
  primary key (ad_id, user_id)
);

create index if not exists ads_created_at_idx on public.ads (created_at desc);
create index if not exists ad_clicks_ad_id_idx on public.ad_clicks (ad_id);
create index if not exists ad_deliveries_ad_id_idx on public.ad_deliveries (ad_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists guild_settings_updated_at on public.guild_settings;
create trigger guild_settings_updated_at
before update on public.guild_settings
for each row execute function public.set_updated_at();

drop trigger if exists ads_updated_at on public.ads;
create trigger ads_updated_at
before update on public.ads
for each row execute function public.set_updated_at();

-- Le verrou sur la campagne rend le débit atomique, même lors de clics simultanés.
-- Un membre ne peut créer qu'un seul clic comptabilisé par campagne (clé primaire ad_id, user_id).
create or replace function public.register_ad_click(
  p_ad_id uuid,
  p_user_id text,
  p_guild_id text
)
returns table (
  status text,
  destination_url text,
  charged_cents integer,
  credits_remaining_cents integer,
  is_active boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ad public.ads%rowtype;
  v_already_clicked boolean;
begin
  select * into v_ad
  from public.ads
  where id = p_ad_id
  for update;

  if not found then
    return query select 'not_found'::text, null::text, 0, null::integer, null::boolean;
    return;
  end if;

  select exists(
    select 1 from public.ad_clicks where ad_id = p_ad_id and user_id = p_user_id
  ) into v_already_clicked;

  if v_already_clicked then
    return query select
      'already_clicked'::text,
      v_ad.destination_url,
      0,
      v_ad.credits_remaining_cents,
      v_ad.is_active;
    return;
  end if;

  if not v_ad.is_active or v_ad.credits_remaining_cents < v_ad.click_cost_cents then
    return query select
      'unavailable'::text,
      null::text,
      0,
      v_ad.credits_remaining_cents,
      v_ad.is_active;
    return;
  end if;

  insert into public.ad_clicks (ad_id, user_id, guild_id)
  values (p_ad_id, p_user_id, p_guild_id);

  update public.ads
  set
    credits_remaining_cents = v_ad.credits_remaining_cents - v_ad.click_cost_cents,
    -- La campagne reste active tant qu'au moins un nouveau clic peut encore être facturé.
    is_active = (v_ad.credits_remaining_cents - v_ad.click_cost_cents) >= v_ad.click_cost_cents
  where id = p_ad_id
  returning * into v_ad;

  return query select
    'charged'::text,
    v_ad.destination_url,
    v_ad.click_cost_cents,
    v_ad.credits_remaining_cents,
    v_ad.is_active;
end;
$$;

-- Le bot utilise uniquement SUPABASE_SERVICE_ROLE_KEY. Aucun client Discord/public n'accède directement aux tables.
alter table public.guild_settings enable row level security;
alter table public.ads enable row level security;
alter table public.ad_deliveries enable row level security;
alter table public.ad_clicks enable row level security;

revoke all on table public.guild_settings, public.ads, public.ad_deliveries, public.ad_clicks from anon, authenticated;
revoke all on function public.register_ad_click(uuid, text, text) from public, anon, authenticated;
grant execute on function public.register_ad_click(uuid, text, text) to service_role;
