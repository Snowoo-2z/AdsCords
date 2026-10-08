export interface CampaignPeriod {
  dayNumber: number;
  startsAtMs: number;
  endsAtMs: number;
  budgetCents: number;
}

/**
 * Découpe une campagne en créneaux complets de 24 h à partir de son instant de création.
 * Le reste des centimes est attribué aux premiers créneaux, afin que la somme soit toujours exacte.
 */
export function campaignPeriodAt(
  startsAt: string,
  durationDays: number,
  initialBudgetCents: number,
  atMs = Date.now()
): CampaignPeriod | null {
  const startsAtMs = new Date(startsAt).getTime();
  if (!Number.isFinite(startsAtMs) || !Number.isInteger(durationDays) || durationDays < 1 || !Number.isInteger(initialBudgetCents) || initialBudgetCents < 0) {
    return null;
  }
  const dayNumber = Math.floor((atMs - startsAtMs) / 86_400_000) + 1;
  if (dayNumber < 1 || dayNumber > durationDays) return null;
  const budgetCents = Math.floor(initialBudgetCents / durationDays) +
    (dayNumber <= initialBudgetCents % durationDays ? 1 : 0);
  const periodStartsAtMs = startsAtMs + (dayNumber - 1) * 86_400_000;
  return {
    dayNumber,
    startsAtMs: periodStartsAtMs,
    endsAtMs: periodStartsAtMs + 86_400_000,
    budgetCents
  };
}
