-- AdsCords - tarification dynamique et protections anti-clics abusifs
-- Exécuter APRÈS 001_initial_schema.sql dans Supabase > SQL Editor.

alter table public.ads alter column click_cost_cents set default 10;

alter table public.ad_clicks
  add column if not exists charged_cents integer not null default 0 check (charged_cents >= 0),
  add column if not exists pricing_reason text not null default 'legacy';

create index if not exists ad_clicks_visitor_clicked_at_idx
  on public.ad_clicks (user_id, clicked_at desc);

-- Une seule ligne contient les réglages modifiables par le propriétaire depuis Discord.
create table if not exists public.click_guard_settings (
  id boolean primary key default true check (id),
  first_daily_click_cents integer not null default 10 check (first_daily_click_cents > 0),
  repeat_click_min_cents integer not null default 2 check (repeat_click_min_cents > 0),
  repeat_click_max_cents integer not null default 4 check (repeat_click_max_cents >= repeat_click_min_cents),
  suspicious_clicks_per_day integer not null default 6 check (suspicious_clicks_per_day >= 2),
  suspicious_days_required integer not null default 3 check (suspicious_days_required >= 1),
  history_window_days integer not null default 7 check (history_window_days >= suspicious_days_required),
  suspension_days integer not null default 2 check (suspension_days >= 1),
  updated_at timestamptz not null default now()
);

insert into public.click_guard_settings (id)
values (true)
on conflict (id) do nothing;

drop trigger if exists click_guard_settings_updated_at on public.click_guard_settings;
create trigger click_guard_settings_updated_at
before update on public.click_guard_settings
for each row execute function public.set_updated_at();

-- Identité technique du visiteur (cookie de la fonction Edge), sans stocker d'IP.
create table if not exists public.click_profiles (
  visitor_id text primary key,
  suspended_until timestamptz,
  suspension_count integer not null default 0 check (suspension_count >= 0),
  last_suspension_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists click_profiles_updated_at on public.click_profiles;
create trigger click_profiles_updated_at
before update on public.click_profiles
for each row execute function public.set_updated_at();

-- Cette version remplace la fonction de 001. Elle verrouille aussi le profil visiteur,
-- ce qui évite que deux clics simultanés contournent le prix quotidien ou le blocage.
-- Le DROP est nécessaire car le contrat de retour ajoute pricing_reason.
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
  v_day_clicks integer;
  v_suspicious_days integer;
  v_charge integer;
  v_reason text;
  v_today date;
  v_is_currently_suspended boolean;
begin
  select * into v_ad
  from public.ads
  where id = p_ad_id
  for update;

  if not found then
    return query select 'not_found'::text, null::text, 0, null::integer, null::boolean, 'not_found'::text;
    return;
  end if;

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

  if not v_ad.is_active then
    return query select
      'unavailable'::text,
      null::text,
      0,
      v_ad.credits_remaining_cents,
      v_ad.is_active,
      'campaign_inactive'::text;
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
  v_is_currently_suspended := v_profile.suspended_until is not null and v_profile.suspended_until > now();

  if v_is_currently_suspended then
    v_charge := 0;
    v_reason := 'suspended';
  else
    select count(*) into v_day_clicks
    from public.ad_clicks
    where user_id = p_user_id
      and (clicked_at at time zone 'Europe/Paris')::date = v_today;

    if v_day_clicks = 0 then
      v_charge := v_settings.first_daily_click_cents;
      v_reason := 'first_daily';
    else
      v_charge := floor(
        random() * (v_settings.repeat_click_max_cents - v_settings.repeat_click_min_cents + 1)
      )::integer + v_settings.repeat_click_min_cents;
      v_reason := 'repeat_daily';
    end if;
  end if;

  if v_charge > 0 and v_ad.credits_remaining_cents < v_charge then
    -- Le budget n'est pas assez élevé pour ce clic ; aucun événement n'est enregistré.
    return query select
      'unavailable'::text,
      null::text,
      0,
      v_ad.credits_remaining_cents,
      v_ad.is_active,
      'insufficient_budget'::text;
    return;
  end if;

  insert into public.ad_clicks (ad_id, user_id, guild_id, charged_cents, pricing_reason)
  values (p_ad_id, p_user_id, p_guild_id, v_charge, v_reason);

  if v_charge > 0 then
    update public.ads
    set
      credits_remaining_cents = v_ad.credits_remaining_cents - v_charge,
      -- Une campagne peut encore servir au moins un clic répété au prix minimum configuré.
      is_active = (v_ad.credits_remaining_cents - v_charge) >= v_settings.repeat_click_min_cents
    where id = p_ad_id
    returning * into v_ad;
  end if;

  -- Après le clic, on examine les jours où ce profil a ouvert beaucoup de campagnes différentes.
  -- Le jour courant fait partie de la fenêtre de 7 jours par défaut.
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

revoke all on table public.click_guard_settings, public.click_profiles from anon, authenticated;
revoke all on function public.register_ad_click(uuid, text, text) from public, anon, authenticated;
grant execute on function public.register_ad_click(uuid, text, text) to service_role;
