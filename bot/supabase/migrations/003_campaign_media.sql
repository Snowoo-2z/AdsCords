-- AdsCords - médias et mode d'affichage des campagnes
-- Exécuter APRÈS 001_initial_schema.sql et 002_dynamic_click_guard.sql.

alter table public.ads
  add column if not exists media_url text check (media_url is null or media_url ~* '^https?://'),
  add column if not exists use_embed boolean not null default true;
