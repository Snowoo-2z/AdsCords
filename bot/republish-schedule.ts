import type { AdCampaign } from './domain.js';

/** Chaque campagne est remplacée au plus tôt cinq heures après sa dernière publication. */
export const REPUBLISH_INTERVAL_MS = 5 * 60 * 60 * 1000;

/**
 * Classe les campagnes de façon stable. La même campagne conserve donc son créneau
 * tant que le nombre de campagnes actives reste identique.
 */
function orderedCampaigns(campaigns: readonly Pick<AdCampaign, 'id' | 'createdAt'>[]): Array<Pick<AdCampaign, 'id' | 'createdAt'>> {
  return [...campaigns].sort((left, right) => {
    const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
    return createdAtOrder !== 0 ? createdAtOrder : left.id.localeCompare(right.id);
  });
}

/**
 * Première remontée d'une campagne dans un salon.
 *
 * La publication initiale reste immédiate. Les remontées suivantes sont étalées
 * sur une fenêtre de cinq heures selon le nombre de campagnes actives : avec N
 * campagnes, deux remontées sont séparées d'environ 5 h / N au lieu d'arriver
 * en rafale dans le même salon.
 */
export function firstRepublishDelayMs(
  campaign: Pick<AdCampaign, 'id' | 'createdAt'>,
  activeCampaigns: readonly Pick<AdCampaign, 'id' | 'createdAt'>[]
): number {
  const ordered = orderedCampaigns(activeCampaigns);
  const campaignIndex = Math.max(0, ordered.findIndex((item) => item.id === campaign.id));
  const campaignCount = Math.max(1, ordered.length);
  const slotOffsetMs = Math.floor((REPUBLISH_INTERVAL_MS * campaignIndex) / campaignCount);
  return REPUBLISH_INTERVAL_MS + slotOffsetMs;
}

/** Après sa première remontée, une campagne conserve simplement son rythme de cinq heures. */
export function nextRepublishAt(deliveredAtMs: number): number {
  return deliveredAtMs + REPUBLISH_INTERVAL_MS;
}
