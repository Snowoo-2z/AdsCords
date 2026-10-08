import { Resvg } from '@resvg/resvg-js';

import { campaignPeriodAt } from './campaign-period.js';
import type { CampaignDashboardItem } from './domain.js';

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function euro(cents: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(cents / 100);
}

function campaignCard(campaign: CampaignDashboardItem, index: number): string {
  const top = 214 + index * 222;
  const active = campaign.isActive;
  const accent = active ? '#6954F6' : '#ABB3C8';
  const badgeBackground = active ? '#EEEAFE' : '#EFF1F6';
  const badgeText = active ? '#5944E2' : '#6F7895';
  const status = active ? 'Active' : 'Terminée';
  const progress = campaign.initialCreditsCents > 0
    ? Math.max(0, Math.min(1, campaign.creditsRemainingCents / campaign.initialCreditsCents))
    : 0;
  const progressWidth = Math.round(248 * progress);
  const period = campaign.durationDays === 0 ? null : campaignPeriodAt(campaign.startsAt, campaign.durationDays, campaign.initialCreditsCents);
  const elapsedDays = period?.dayNumber ?? 0;
  const dailyBudget = period?.budgetCents ?? campaign.creditsRemainingCents;
  const rewardLabel = campaign.rewardType === 'bonus' ? 'CRÉDITS BONUS' : 'EUROS';
  const dailyUnit = campaign.rewardType === 'bonus' ? 'crédits/jour' : '€/jour';
  const bonusNumber = (cents: number) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
  const dailyValue = campaign.rewardType === 'bonus' ? bonusNumber(dailyBudget) : euro(dailyBudget);
  const pacingLabel = campaign.durationDays === 0
    ? 'Sans durée • jusqu’à épuisement du budget'
    : `J. ${elapsedDays}/${campaign.durationDays} • ${dailyValue} ${dailyUnit}`;
  const remainingValue = campaign.rewardType === 'bonus' ? `${bonusNumber(campaign.creditsRemainingCents)} crédits` : euro(campaign.creditsRemainingCents);
  const initialValue = campaign.rewardType === 'bonus' ? `${bonusNumber(campaign.initialCreditsCents)} crédits` : euro(campaign.initialCreditsCents);
  const remainingLabel = campaign.rewardType === 'bonus' ? 'BONUS RESTANTS' : 'CRÉDITS RESTANTS';
  const initialLabel = campaign.rewardType === 'bonus' ? 'BUDGET BONUS' : 'BUDGET INITIAL';

  return `
    <g>
      <rect x="44" y="${top}" width="1112" height="194" rx="24" fill="#FFFFFF" stroke="#E5E8F4" stroke-width="2"/>
      <rect x="44" y="${top}" width="8" height="194" rx="4" fill="${accent}"/>
      <text x="86" y="${top + 45}" class="cardTitle">Campagne #${escapeXml(campaign.id.slice(0, 8).toUpperCase())}</text>
      <text x="86" y="${top + 78}" class="description">${escapeXml(compactText(campaign.description, 86))}</text>
      <text x="86" y="${top + 101}" class="rewardTag">${rewardLabel}</text>

      <rect x="924" y="${top + 24}" width="178" height="42" rx="21" fill="${badgeBackground}"/>
      <circle cx="950" cy="${top + 45}" r="6" fill="${accent}"/>
      <text x="970" y="${top + 51}" class="badge" fill="${badgeText}">${status}</text>

      <text x="86" y="${top + 120}" class="statLabel">CLICS UNIQUES</text>
      <text x="86" y="${top + 157}" class="statValue">${campaign.uniqueClicks}</text>
      <line x1="220" y1="${top + 107}" x2="220" y2="${top + 165}" stroke="#E6E8F2" stroke-width="2"/>

      <text x="254" y="${top + 120}" class="statLabel">${remainingLabel}</text>
      <text x="254" y="${top + 157}" class="statValue">${escapeXml(remainingValue)}</text>
      <line x1="526" y1="${top + 107}" x2="526" y2="${top + 165}" stroke="#E6E8F2" stroke-width="2"/>

      <text x="560" y="${top + 120}" class="statLabel">${initialLabel}</text>
      <text x="560" y="${top + 157}" class="statValue">${escapeXml(initialValue)}</text>

      <rect x="842" y="${top + 123}" width="248" height="14" rx="7" fill="#E8EAF4"/>
      <rect x="842" y="${top + 123}" width="${progressWidth}" height="14" rx="7" fill="${accent}"/>
      <text x="842" y="${top + 167}" class="progressText">${escapeXml(pacingLabel)}</text>
      <text x="86" y="${top + 187}" class="statSub">Diffusion active : ${campaign.deliveryCount} serveur${campaign.deliveryCount > 1 ? 's' : ''}</text>
    </g>`;
}

/** Image complète de MaPub, au style lisse violet/blanc assorti à AdsCords. */
export function createMapubDashboardPng(campaigns: CampaignDashboardItem[], title = 'MES CAMPAGNES'): Buffer {
  const displayed = campaigns.slice(0, 12);
  const height = displayed.length === 0 ? 442 : 214 + displayed.length * 222 + 52;
  const cards = displayed.map(campaignCard).join('');
  const noCampaign = displayed.length === 0
    ? `
      <rect x="44" y="214" width="1112" height="172" rx="22" fill="#FFFFFF" stroke="#E8EAF4" stroke-width="2"/>
      <circle cx="122" cy="300" r="36" fill="#EEEAFE"/>
      <path d="M108 300h28M122 286v28" stroke="#6E5AF6" stroke-width="4" stroke-linecap="round"/>
      <text x="190" y="291" class="emptyTitle">Aucune campagne rattachée</text>
      <text x="190" y="327" class="emptyText">Ouvre un ticket pour créer une campagne.</text>`
    : cards;

  const svg = `
  <svg width="1200" height="${height}" viewBox="0 0 1200 ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="background" x1="0" y1="0" x2="1200" y2="${height}" gradientUnits="userSpaceOnUse">
        <stop stop-color="#F9FAFE"/>
        <stop offset="1" stop-color="#F0F1FC"/>
      </linearGradient>
      <linearGradient id="brand" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
        <stop stop-color="#896EFF"/>
        <stop offset="1" stop-color="#5742E6"/>
      </linearGradient>
      <style>
        .title { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 48px; font-weight: 700; fill: #1E2342; letter-spacing: -0.5px; }
        .subtitle { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 22px; font-weight: 500; fill: #747D9E; }
        .count { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 22px; font-weight: 700; fill: #FFFFFF; }
        .cardTitle { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 26px; font-weight: 700; fill: #242948; }
        .description { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 18px; font-weight: 400; fill: #717A99; }
        .rewardTag { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 12px; font-weight: 700; fill: #735CF4; letter-spacing: 1.2px; }
        .badge { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 16px; font-weight: 700; }
        .statLabel { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 13px; font-weight: 700; fill: #9098B3; letter-spacing: 1px; }
        .statValue { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 25px; font-weight: 700; fill: #303758; }
        .statSub { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 13px; font-weight: 400; fill: #8B93AD; }
        .progressText { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 14px; font-weight: 500; fill: #7A839F; }
        .emptyTitle { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 28px; font-weight: 700; fill: #282E4E; }
        .emptyText { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 20px; font-weight: 400; fill: #747D9E; }
        .footer { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 14px; font-weight: 500; fill: #9AA1B8; }
      </style>
    </defs>
    <rect width="1200" height="${height}" rx="28" fill="url(#background)"/>
    <rect x="0" y="0" width="1200" height="166" rx="28" fill="#FFFFFF"/>
    <rect x="0" y="138" width="1200" height="28" fill="#FFFFFF"/>

    <circle cx="96" cy="82" r="39" fill="url(#brand)"/>
    <rect x="75" y="66" width="27" height="15" rx="6.5" fill="none" stroke="#FFFFFF" stroke-width="4"/>
    <rect x="88" y="84" width="27" height="15" rx="6.5" fill="none" stroke="#FFFFFF" stroke-width="4"/>
    <circle cx="90" cy="73" r="2.5" fill="#FFFFFF"/>
    <circle cx="103" cy="91" r="2.5" fill="#FFFFFF"/>

    <text x="155" y="78" class="title">MaPub</text>
    <text x="155" y="116" class="subtitle">${escapeXml(title)}</text>
    <rect x="928" y="56" width="214" height="58" rx="18" fill="#6250E9"/>
    <text x="960" y="92" class="count">${campaigns.length} campagne${campaigns.length > 1 ? 's' : ''}</text>

    ${noCampaign}
    ${displayed.length > 0 ? cards : ''}
    <text x="56" y="${height - 20}" class="footer">AdsCords • Clics uniques pseudonymisés, pas de comptage des vues Discord</text>
  </svg>`;

  const renderer = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } });
  return Buffer.from(renderer.render().asPng());
}
