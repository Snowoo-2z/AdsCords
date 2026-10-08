-- AdsCords - nettoyage unique des messages et routes des campagnes expirées ou épuisées.
-- À exécuter APRÈS 007_campaign_24h_periods.sql.

alter table public.ads
  add column if not exists delivery_cleaned_at timestamptz;

create index if not exists ads_delivery_cleanup_idx
  on public.ads (delivery_cleaned_at)
  where delivery_cleaned_at is null;
