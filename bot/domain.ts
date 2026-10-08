export interface GuildSettings {
  guildId: string;
  adChannelId: string;
  ownerDiscordId: string | null;
  updatedAt: string;
}

export type CampaignRewardType = 'cash' | 'bonus';

export interface AdCampaign {
  id: string;
  ownerDiscordId: string;
  destinationUrl: string;
  description: string;
  mediaUrl: string | null;
  useEmbed: boolean;
  rewardType: CampaignRewardType;
  /** 0 = campagne sans durée, arrêtée uniquement quand son budget est épuisé. */
  durationDays: number;
  startsAt: string;
  endsAt: string | null;
  initialCreditsCents: number;
  creditsRemainingCents: number;
  clickCostCents: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdDelivery {
  id: string;
  adId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  deliveredAt: string;
  /** Date persistée de la prochaine remontée afin que les redémarrages ne cassent pas la rotation. */
  nextRepublishAt: string;
}

export type ClickResultStatus = 'charged' | 'already_clicked' | 'unavailable' | 'not_found';

export interface ClickResult {
  status: ClickResultStatus;
  destinationUrl: string | null;
  chargedCents: number;
  creditsRemainingCents: number | null;
  isActive: boolean | null;
  pricingReason: string | null;
}

export interface CampaignDashboardItem extends AdCampaign {
  uniqueClicks: number;
}

export interface RefreshableCampaign extends AdCampaign {
  dailyBudgetCents: number;
  spentTodayCents: number;
}

export interface ClickGuardSettings {
  firstDailyClickCents: number;
  firstValueCooldownDays: number;
  repeatClickMinCents: number;
  repeatClickMaxCents: number;
  suspiciousClicksPerDay: number;
  suspiciousDaysRequired: number;
  historyWindowDays: number;
  suspensionDays: number;
  updatedAt: string;
}

export interface ClickLogEntry {
  visitorId: string;
  adId: string;
  guildId: string;
  chargedCents: number;
  pricingReason: string;
  clickedAt: string;
  suspendedUntil: string | null;
}

export interface GuildEarnings {
  guildId: string;
  cashMilliCents: number;
  bonusMilliCents: number;
  paidClicks: number;
}

export interface EarningsSummary {
  cashMilliCents: number;
  bonusMilliCents: number;
  paidClicks: number;
  guilds: GuildEarnings[];
}

export interface ProfileSummary {
  completedCampaigns: number;
  completedCampaignClicks: number;
  completedCampaignSpendCents: number;
  completedBonusCampaigns: number;
  serverEarnings: EarningsSummary;
  bonusWalletMilliCents: number;
}

export interface OwnerEarningsSummary {
  platformCashMilliCents: number;
  serverCashMilliCents: number;
  serverBonusMilliCents: number;
  paidClicks: number;
}
