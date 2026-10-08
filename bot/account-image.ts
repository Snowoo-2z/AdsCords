import { Resvg } from '@resvg/resvg-js';

import type { EarningsSummary, OwnerEarningsSummary, ProfileSummary } from './domain.js';
import { formatBonusCreditsFromMilliCents, formatEuro, formatEuroFromMilliCents } from './currency.js';

function xml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function truncate(value: string, max = 34): string {
  const clean = value.replace(/\s+/gu, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function render(svg: string): Buffer {
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng());
}

function baseStyle(): string {
  return `
    .title { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 46px; font-weight: 700; fill: #202648; }
    .subtitle { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 19px; font-weight: 500; fill: #747E9F; }
    .label { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 13px; font-weight: 700; fill: #8A93B0; letter-spacing: 1px; }
    .value { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 28px; font-weight: 700; fill: #30385D; }
    .cardTitle { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 24px; font-weight: 700; fill: #293052; }
    .cardLabel { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 13px; font-weight: 700; fill: #8992AF; letter-spacing: 0.8px; }
    .cardValue { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 21px; font-weight: 700; fill: #414A70; }
    .foot { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 14px; font-weight: 500; fill: #939BB6; }
  `;
}

function shell(height: number, title: string, subtitle: string, body: string, footer: string): Buffer {
  return render(`
  <svg width="1200" height="${height}" viewBox="0 0 1200 ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="${height}" gradientUnits="userSpaceOnUse">
        <stop stop-color="#FAFBFF"/><stop offset="1" stop-color="#F0F1FC"/>
      </linearGradient>
      <linearGradient id="brand" x1="0" y1="0" x2="80" y2="80" gradientUnits="userSpaceOnUse">
        <stop stop-color="#8E75FF"/><stop offset="1" stop-color="#5641E5"/>
      </linearGradient>
      <style>${baseStyle()}</style>
    </defs>
    <rect width="1200" height="${height}" rx="28" fill="url(#bg)"/>
    <rect width="1200" height="168" rx="28" fill="#FFFFFF"/>
    <rect y="140" width="1200" height="28" fill="#FFFFFF"/>
    <circle cx="96" cy="84" r="39" fill="url(#brand)"/>
    <rect x="75" y="67" width="27" height="15" rx="7.5" fill="none" stroke="#FFFFFF" stroke-width="4"/>
    <rect x="88" y="85" width="27" height="15" rx="7.5" fill="none" stroke="#FFFFFF" stroke-width="4"/>
    <circle cx="90" cy="74" r="2.5" fill="#FFFFFF"/><circle cx="103" cy="92" r="2.5" fill="#FFFFFF"/>
    <text x="156" y="80" class="title">${xml(title)}</text>
    <text x="156" y="117" class="subtitle">${xml(subtitle)}</text>
    ${body}
    <text x="56" y="${height - 22}" class="foot">${xml(footer)}</text>
  </svg>`);
}

function summaryCard(x: number, label: string, value: string, accent: string): string {
  return `
    <rect x="${x}" y="210" width="344" height="112" rx="22" fill="#FFFFFF" stroke="#E5E8F4" stroke-width="2"/>
    <rect x="${x}" y="210" width="8" height="112" rx="4" fill="${accent}"/>
    <text x="${x + 30}" y="251" class="label">${xml(label)}</text>
    <text x="${x + 30}" y="292" class="value">${xml(value)}</text>`;
}

/** Dashboard image-only des gains attribués aux serveurs d'un propriétaire. */
export function createEarningsDashboardPng(summary: EarningsSummary, guildNames: Map<string, string>): Buffer {
  const displayed = summary.guilds.slice(0, 25);
  const noRows = displayed.length === 0;
  const height = noRows ? 490 : 366 + displayed.length * 128 + 42;
  const cards = displayed.map((guild, index) => {
    const top = 358 + index * 128;
    const name = guildNames.get(guild.guildId) ?? `Serveur ${guild.guildId}`;
    return `
      <rect x="44" y="${top}" width="1112" height="104" rx="22" fill="#FFFFFF" stroke="#E5E8F4" stroke-width="2"/>
      <rect x="44" y="${top}" width="8" height="104" rx="4" fill="#6954F6"/>
      <text x="86" y="${top + 43}" class="cardTitle">${xml(truncate(name, 42))}</text>
      <text x="86" y="${top + 72}" class="cardLabel">${guild.paidClicks} CLIC${guild.paidClicks > 1 ? 'S' : ''} VALORISÉ${guild.paidClicks > 1 ? 'S' : ''}</text>
      <text x="554" y="${top + 37}" class="cardLabel">GAINS €</text>
      <text x="554" y="${top + 72}" class="cardValue">${xml(formatEuroFromMilliCents(guild.cashMilliCents))}</text>
      <text x="836" y="${top + 37}" class="cardLabel">CRÉDITS BONUS</text>
      <text x="836" y="${top + 72}" class="cardValue">${xml(formatBonusCreditsFromMilliCents(guild.bonusMilliCents))}</text>`;
  }).join('');
  const empty = `
    <rect x="44" y="358" width="1112" height="94" rx="22" fill="#FFFFFF" stroke="#E5E8F4" stroke-width="2"/>
    <circle cx="102" cy="405" r="26" fill="#EEEAFE"/>
    <path d="M91 405h22M102 394v22" stroke="#6954F6" stroke-width="4" stroke-linecap="round"/>
    <text x="154" y="401" class="cardTitle">Aucun gain enregistré pour le moment</text>
    <text x="154" y="429" class="subtitle">Configure un salon avec .config puis attends des clics valorisés.</text>`;
  const more = summary.guilds.length > displayed.length
    ? ` • ${summary.guilds.length - displayed.length} autre(s) serveur(s) à consulter ultérieurement`
    : '';

  return shell(
    height,
    'Mes gains',
    'Récapitulatif de tous tes serveurs AdsCords',
    `${summaryCard(44, 'GAINS EN EUROS', formatEuroFromMilliCents(summary.cashMilliCents), '#6954F6')}
     ${summaryCard(428, 'CRÉDITS BONUS', formatBonusCreditsFromMilliCents(summary.bonusMilliCents), '#27B89A')}
     ${summaryCard(812, 'CLICS VALORISÉS', String(summary.paidClicks), '#F2A640')}
     ${noRows ? empty : cards}`,
    `AdsCords • Gains attribués au propriétaire du serveur au moment du clic${more}`
  );
}

/** Profil récapitulatif sans liste de campagnes en cours et sans revenus AdsCords. */
export function createProfileDashboardPng(summary: ProfileSummary): Buffer {
  const body = `
    ${summaryCard(44, 'CAMPAGNES TERMINÉES', String(summary.completedCampaigns), '#6954F6')}
    ${summaryCard(428, 'CLICS TERMINÉS', String(summary.completedCampaignClicks), '#F2A640')}
    ${summaryCard(812, 'BUDGET CONSOMMÉ', formatEuro(summary.completedCampaignSpendCents), '#6954F6')}
    <rect x="44" y="378" width="344" height="112" rx="22" fill="#FFFFFF" stroke="#E5E8F4" stroke-width="2"/>
    <rect x="44" y="378" width="8" height="112" rx="4" fill="#26B99A"/>
    <text x="74" y="419" class="label">GAINS SERVEURS (€)</text>
    <text x="74" y="460" class="value">${xml(formatEuroFromMilliCents(summary.serverEarnings.cashMilliCents))}</text>
    <rect x="428" y="378" width="344" height="112" rx="22" fill="#FFFFFF" stroke="#E5E8F4" stroke-width="2"/>
    <rect x="428" y="378" width="8" height="112" rx="4" fill="#26B99A"/>
    <text x="458" y="419" class="label">SOLDE CRÉDITS BONUS</text>
    <text x="458" y="460" class="value">${xml(formatBonusCreditsFromMilliCents(summary.bonusWalletMilliCents))}</text>
    <rect x="812" y="378" width="344" height="112" rx="22" fill="#FFFFFF" stroke="#E5E8F4" stroke-width="2"/>
    <rect x="812" y="378" width="8" height="112" rx="4" fill="#6954F6"/>
    <text x="842" y="419" class="label">SERVEURS RÉMUNÉRÉS</text>
    <text x="842" y="460" class="value">${summary.serverEarnings.guilds.length}</text>
    <text x="56" y="535" class="subtitle">${summary.completedBonusCampaigns} campagne${summary.completedBonusCampaigns > 1 ? 's' : ''} bonus terminée${summary.completedBonusCampaigns > 1 ? 's' : ''} • ${summary.serverEarnings.paidClicks} clic${summary.serverEarnings.paidClicks > 1 ? 's' : ''} ayant généré un gain serveur</text>`;

  return shell(
    584,
    'Mon profil',
    'Vue globale du compte • les publicités en cours ne sont pas affichées',
    body,
    'AdsCords • Les crédits bonus sont réservés aux campagnes publicitaires'
  );
}

/** Vue financière strictement réservée au propriétaire AdsCords. */
export function createOwnerDashboardPng(summary: OwnerEarningsSummary): Buffer {
  const body = `
    ${summaryCard(44, 'GAINS ADSCORDS (€)', formatEuroFromMilliCents(summary.platformCashMilliCents), '#6954F6')}
    ${summaryCard(428, 'PART SERVEURS (€)', formatEuroFromMilliCents(summary.serverCashMilliCents), '#26B99A')}
    ${summaryCard(812, 'CLICS VALORISÉS', String(summary.paidClicks), '#F2A640')}
    <rect x="44" y="378" width="1112" height="112" rx="22" fill="#FFFFFF" stroke="#E5E8F4" stroke-width="2"/>
    <rect x="44" y="378" width="8" height="112" rx="4" fill="#26B99A"/>
    <text x="86" y="419" class="label">CRÉDITS BONUS ATTRIBUÉS AUX SERVEURS</text>
    <text x="86" y="460" class="value">${xml(formatBonusCreditsFromMilliCents(summary.serverBonusMilliCents))}</text>
    <text x="456" y="456" class="subtitle">Les campagnes bonus ne génèrent pas d'euros pour AdsCords.</text>`;

  return shell(
    548,
    'Espace propriétaire',
    'Synthèse des revenus générés par AdsCords',
    body,
    'AdsCords • Accès réservé au propriétaire du bot'
  );
}
