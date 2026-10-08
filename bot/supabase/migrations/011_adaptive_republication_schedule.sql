-- AdsCords - rotation adaptative des campagnes dans les salons publicitaires
-- Exécuter APRÈS 010_fix_click_rpc_column_ambiguity.sql dans Supabase > SQL Editor.
-- Une campagne reste affichée au minimum cinq heures. Les premières remontées
-- sont réparties automatiquement selon le nombre de campagnes dans chaque salon.

alter table public.ad_deliveries
  add column if not exists next_republish_at timestamptz;

-- Les diffusions déjà présentes reçoivent elles aussi un créneau réparti. Les
-- campagnes inactives reçoivent une valeur neutre : le nettoyeur les supprime.
with ranked_active_deliveries as (
  select
    deliveries.id,
    deliveries.delivered_at,
    row_number() over (
      partition by deliveries.guild_id
      order by ads.created_at asc, ads.id asc
    ) - 1 as campaign_position,
    count(*) over (partition by deliveries.guild_id) as campaign_count
  from public.ad_deliveries as deliveries
  join public.ads as ads on ads.id = deliveries.ad_id
  where ads.is_active = true
    and (ads.ends_at is null or ads.ends_at > now())
)
update public.ad_deliveries as deliveries
set next_republish_at = ranked.delivered_at
  + interval '5 hours'
  + interval '5 hours' * (ranked.campaign_position::double precision / ranked.campaign_count)
from ranked_active_deliveries as ranked
where deliveries.id = ranked.id
  and deliveries.next_republish_at is null;

update public.ad_deliveries
set next_republish_at = delivered_at + interval '5 hours'
where next_republish_at is null;

alter table public.ad_deliveries
  alter column next_republish_at set not null;

create index if not exists ad_deliveries_next_republish_at_idx
  on public.ad_deliveries (next_republish_at);
