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
  /** Jeton aléatoire de l'unique message Discord qui porte ce lien de suivi. */
  deliveryToken: string;
  /** 0 = message pré-migration, 1 = lien signé par jeton. */
  trackingVersion: number;
  deliveredAt: string;
  /** Date persistée de la prochaine remontée afin que les redémarrages ne cassent pas la rotation. */
  nextRepublishAt: string;
}

export interface CampaignDashboardItem extends AdCampaign {
  /** Clics dédupliqués par navigateur pseudonymisé, et non des vues Discord. */
  uniqueClicks: number;
  /** Nombre actuel de serveurs dans lesquels la campagne est effectivement diffusée. */
  deliveryCount: number;
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
