/** Convertit un montant saisi en euros ("10", "10,50", "10.50") en centimes, sans flottant. */
export function euroToCents(input: string): number | null {
  const normalized = input.trim().replace(/\s/g, '').replace(',', '.').replace(/€$/u, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;

  const wholePart = Number.parseInt(match[1] ?? '', 10);
  const decimalPart = (match[2] ?? '').padEnd(2, '0');
  const centsPart = decimalPart ? Number.parseInt(decimalPart, 10) : 0;
  const cents = wholePart * 100 + centsPart;

  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function formatEuro(cents: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(cents / 100);
}

/** Les partages 30/70 sont conservés au milli-cent afin de ne jamais perdre les petites valeurs. */
export function formatEuroFromMilliCents(milliCents: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(milliCents / 100_000);
}

export function formatBonusCreditsFromMilliCents(milliCents: number): string {
  const value = new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(milliCents / 100_000);
  return `${value} crédits bonus`;
}

export function progressBar(initialCents: number, remainingCents: number, width = 10): string {
  if (initialCents <= 0) return '░'.repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((remainingCents / initialCents) * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}
