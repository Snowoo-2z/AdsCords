import { randomUUID } from 'node:crypto';

import { Client, Guild, type GuildTextBasedChannel, type Message } from 'discord.js';

import { env } from './environment.js';
import { AdsRepository } from './ads-repository.js';
import { EarningsRepository } from './earnings-repository.js';
import { BonusRepository } from './bonus-repository.js';
import { SettingsRepository } from './settings-repository.js';
import type {
  AdCampaign,
  AdDelivery,
  CampaignRewardType,
  ClickGuardSettings,
  EarningsSummary,
  OwnerEarningsSummary,
  ProfileSummary
} from './domain.js';
import { adEmbed, adRow } from './embeds.js';
import { firstRepublishDelayMs, nextRepublishAt, REPUBLISH_INTERVAL_MS } from './republish-schedule.js';

export interface PublishSummary {
  sent: number;
  failed: number;
}

interface CampaignDraft {
  creatorDiscordId: string;
  campaignOwnerDiscordId: string;
  channelId: string;
  destinationUrl: string;
  description: string;
  useEmbed: boolean;
  rewardType: CampaignRewardType;
  durationDays: number;
  creditsCents: number;
  clickCostCents: number;
  expiresAt: number;
}

export interface PublishedDraft {
  campaign: AdCampaign;
  summary: PublishSummary;
}

export interface ClearCampaignsSummary {
  deletedMessages: number;
  failedMessages: number;
  deletedCampaigns: number;
}

interface CampaignMedia {
  url: string;
  filename: string;
  content: Buffer;
}

const DRAFT_LIFETIME_MS = 10 * 60 * 1000;
export const MAX_CAMPAIGN_MEDIA_BYTES = 8 * 1024 * 1024;
// La vérification reste fréquente afin de respecter les créneaux, sans republier plus d'une fois toutes les 5 h.
const REPUBLISH_CHECK_INTERVAL_MS = 60 * 1000;

function isSupportedCampaignMedia(content: Buffer): boolean {
  const png = content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  const gif = content.subarray(0, 6).toString('ascii') === 'GIF87a' || content.subarray(0, 6).toString('ascii') === 'GIF89a';
  const webp = content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP';
  const avif = content.subarray(4, 8).toString('ascii') === 'ftyp' && content.subarray(8, 24).toString('ascii').includes('avif');
  return png || jpeg || gif || webp || avif;
}

export class CampaignService {
  public constructor(
    private readonly adsRepository: AdsRepository,
    private readonly settingsRepository: SettingsRepository,
    private readonly earningsRepository: EarningsRepository,
    private readonly bonusRepository: BonusRepository,
    private readonly client: Client
  ) {}

  private readonly drafts = new Map<string, CampaignDraft>();
  private republishTimer: NodeJS.Timeout | null = null;
  private isRefreshingCampaigns = false;

  async createCampaign(input: {
    ownerDiscordId: string;
    destinationUrl: string;
    description: string;
    mediaUrl: string | null;
    useEmbed: boolean;
    rewardType: CampaignRewardType;
    durationDays: number;
    creditsCents: number;
    clickCostCents: number;
  }): Promise<AdCampaign> {
    return this.adsRepository.create(input);
  }

  async publish(ad: AdCampaign, media?: CampaignMedia): Promise<PublishSummary> {
    const [settings, activeCampaigns] = await Promise.all([
      this.settingsRepository.list(),
      this.adsRepository.refreshableCampaigns()
    ]);
    const rotationCampaigns = activeCampaigns.some((campaign) => campaign.id === ad.id) ? activeCampaigns : [...activeCampaigns, ad];
    const firstDelayMs = firstRepublishDelayMs(ad, rotationCampaigns);

    await Promise.allSettled(settings.map((setting) => this.syncGuildOwner(setting.guildId, setting.ownerDiscordId)));
    const results = await Promise.allSettled(
      settings.map((setting) => this.publishToGuild(ad, setting.guildId, setting.adChannelId, media, firstDelayMs))
    );
    return {
      sent: results.filter((result) => result.status === 'fulfilled').length,
      failed: results.filter((result) => result.status === 'rejected').length
    };
  }

  startRepublishing(): void {
    if (this.republishTimer) return;
    // Au redémarrage, les créneaux stockés en base empêchent toute republication prématurée.
    void this.refreshActiveCampaigns().catch((error: unknown) => {
      console.error('[AdsCords] Première republication des campagnes impossible', error);
    });
    this.republishTimer = setInterval(() => {
      void this.refreshActiveCampaigns().catch((error: unknown) => {
        console.error('[AdsCords] Republication des campagnes impossible', error);
      });
    }, REPUBLISH_CHECK_INTERVAL_MS);
    this.republishTimer.unref();
  }

  async refreshActiveCampaigns(): Promise<{ reposted: number; failed: number }> {
    if (this.isRefreshingCampaigns) return { reposted: 0, failed: 0 };
    this.isRefreshingCampaigns = true;
    try {
      await this.cleanExpiredCampaigns();
      const [refreshableCampaigns, activeCampaigns, settings, deliveries] = await Promise.all([
        this.adsRepository.refreshableCampaigns(),
        this.adsRepository.activeCampaigns(),
        this.settingsRepository.list(),
        this.adsRepository.listAllDeliveries()
      ]);
      const deliveryByCampaignAndGuild = new Map(deliveries.map((delivery) => [`${delivery.adId}:${delivery.guildId}`, delivery]));
      const campaignById = new Map<string, AdCampaign>(refreshableCampaigns.map((campaign) => [campaign.id, campaign]));
      // Après la migration des liens sécurisés, une seule remontée immédiate remplace les messages
      // historiques par des messages avec jeton. Elle est faite même si le budget du créneau est plein.
      for (const campaign of activeCampaigns) {
        if (deliveries.some((delivery) => delivery.adId === campaign.id && delivery.trackingVersion < 1)) {
          campaignById.set(campaign.id, campaign);
        }
      }
      const campaigns = [...campaignById.values()];
      const now = Date.now();
      const tasks: Array<Promise<void>> = [];

      for (const campaign of campaigns) {
        for (const setting of settings) {
          const previous = deliveryByCampaignAndGuild.get(`${campaign.id}:${setting.guildId}`);
          // Sans diffusion, après un incident Discord ou pour remplacer une ancienne URL non tokenisée,
          // la campagne est rétablie immédiatement.
          if (previous && previous.trackingVersion >= 1 && now < new Date(previous.nextRepublishAt).getTime()) continue;
          tasks.push(this.republishToGuild(campaign, setting.guildId, setting.adChannelId, previous, undefined, REPUBLISH_INTERVAL_MS));
        }
      }

      const results = await Promise.allSettled(tasks);
      return {
        reposted: results.filter((result) => result.status === 'fulfilled').length,
        failed: results.filter((result) => result.status === 'rejected').length
      };
    } finally {
      this.isRefreshingCampaigns = false;
    }
  }

  /** Retire une seule fois les messages et liens de suivi des campagnes expirées ou épuisées. */
  private async cleanExpiredCampaigns(): Promise<void> {
    const campaignIds = await this.adsRepository.campaignsNeedingDeliveryCleanup();
    if (campaignIds.length === 0) return;

    const deliveries = (await this.adsRepository.listAllDeliveries()).filter((delivery) => campaignIds.includes(delivery.adId));
    await Promise.allSettled(
      deliveries.map(async (delivery) => {
        const guild = await this.getGuild(delivery.guildId);
        if (!guild) return;
        const channel = await guild.channels.fetch(delivery.channelId);
        if (!channel?.isTextBased() || channel.isDMBased()) return;
        const message = await (channel as GuildTextBasedChannel).messages.fetch(delivery.messageId);
        await message.delete();
      })
    );
    // Les anciennes URLs de suivi deviennent immédiatement invalides, même si Discord a déjà supprimé un message.
    await this.adsRepository.removeDeliveries(deliveries.map((delivery) => delivery.id));
    await this.adsRepository.markCampaignDeliveriesCleaned(campaignIds);
  }

  /** Publie sans attendre les campagnes encore diffusables lorsqu'un nouveau serveur termine .config. */
  async publishActiveToGuild(guildId: string): Promise<PublishSummary> {
    const [campaigns, settings, deliveries] = await Promise.all([
      this.adsRepository.refreshableCampaigns(),
      this.settingsRepository.list(),
      this.adsRepository.listAllDeliveries()
    ]);
    const setting = settings.find((item) => item.guildId === guildId);
    if (!setting) return { sent: 0, failed: 0 };

    const tasks = campaigns.map((campaign) => {
      const previous = deliveries.find((delivery) => delivery.adId === campaign.id && delivery.guildId === guildId);
      // Pour un serveur ajouté après la création, on recopie le visuel d'une publication existante.
      const mediaSource = previous ?? deliveries.find((delivery) => delivery.adId === campaign.id);
      const nextDelayMs = previous ? REPUBLISH_INTERVAL_MS : firstRepublishDelayMs(campaign, campaigns);
      return this.republishToGuild(campaign, guildId, setting.adChannelId, previous, mediaSource, nextDelayMs);
    });
    const results = await Promise.allSettled(tasks);
    return {
      sent: results.filter((result) => result.status === 'fulfilled').length,
      failed: results.filter((result) => result.status === 'rejected').length
    };
  }

  startDraft(input: Omit<CampaignDraft, 'expiresAt'>): void {
    this.drafts.set(input.creatorDiscordId, { ...input, expiresAt: Date.now() + DRAFT_LIFETIME_MS });
  }

  async publishDraft(ownerDiscordId: string, media: CampaignMedia | null): Promise<PublishedDraft | null> {
    const draft = this.drafts.get(ownerDiscordId);
    if (!draft || draft.expiresAt < Date.now()) {
      this.drafts.delete(ownerDiscordId);
      return null;
    }
    this.drafts.delete(ownerDiscordId);

    try {
      const campaign = await this.createCampaign({
        ownerDiscordId: draft.campaignOwnerDiscordId,
        destinationUrl: draft.destinationUrl,
        description: draft.description,
        mediaUrl: media?.url ?? null,
        useEmbed: draft.useEmbed,
        rewardType: draft.rewardType,
        durationDays: draft.durationDays,
        creditsCents: draft.creditsCents,
        clickCostCents: draft.clickCostCents
      });
      const summary = await this.publish(campaign, media ?? undefined);
      return { campaign, summary };
    } catch (error) {
      // La saisie reste disponible si Supabase ou Discord est momentanément indisponible.
      this.drafts.set(ownerDiscordId, draft);
      throw error;
    }
  }

  async publishDraftFromAttachment(
    ownerDiscordId: string,
    channelId: string,
    mediaUrl: string,
    filename: string
  ): Promise<PublishedDraft | null> {
    const draft = this.drafts.get(ownerDiscordId);
    if (!draft || draft.channelId !== channelId) return null;

    // La pièce jointe est copiée par le bot dans chaque publication avant que le message source soit supprimé.
    const response = await fetch(mediaUrl);
    if (!response.ok) throw new Error(`Impossible de télécharger le visuel Discord (${response.status}).`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CAMPAIGN_MEDIA_BYTES) {
      throw new Error('Le visuel dépasse la limite de 8 Mo.');
    }
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length === 0) throw new Error('Le visuel Discord est vide.');
    if (content.length > MAX_CAMPAIGN_MEDIA_BYTES) throw new Error('Le visuel dépasse la limite de 8 Mo.');
    if (!isSupportedCampaignMedia(content)) {
      throw new Error('Le fichier doit être une image PNG, JPEG, GIF, WebP ou AVIF valide.');
    }

    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/gu, '_') || 'media';
    return this.publishDraft(ownerDiscordId, { url: mediaUrl, filename: safeFilename, content });
  }

  async dashboard(ownerDiscordId?: string) {
    return this.adsRepository.dashboard(12, ownerDiscordId);
  }

  async clickGuardSettings() {
    return this.adsRepository.clickGuardSettings();
  }

  async saveClickGuardSettings(input: Omit<ClickGuardSettings, 'historyWindowDays' | 'updatedAt'>) {
    return this.adsRepository.saveClickGuardSettings(input);
  }

  async recentClickLogs(limit: number) {
    return this.adsRepository.recentClickLogs(limit);
  }

  async earnings(ownerDiscordId: string): Promise<EarningsSummary> {
    return this.earningsRepository.forOwner(ownerDiscordId);
  }

  async profile(discordUserId: string): Promise<ProfileSummary> {
    const [campaigns, serverEarnings, bonusWalletMilliCents] = await Promise.all([
      this.adsRepository.campaignsForProfile(discordUserId),
      this.earningsRepository.forOwner(discordUserId),
      this.bonusRepository.balance(discordUserId)
    ]);
    const now = Date.now();
    // Les annonces actuellement en ligne ne sont pas affichées dans le profil ; seules les campagnes terminées sont agrégées.
    const completed = campaigns.filter((campaign) => !campaign.isActive || (campaign.endsAt !== null && new Date(campaign.endsAt).getTime() <= now));
    return {
      completedCampaigns: completed.length,
      completedCampaignClicks: completed.reduce((total, campaign) => total + campaign.uniqueClicks, 0),
      completedCampaignSpendCents: completed.reduce(
        (total, campaign) => total + Math.max(0, campaign.initialCreditsCents - campaign.creditsRemainingCents),
        0
      ),
      completedBonusCampaigns: completed.filter((campaign) => campaign.rewardType === 'bonus').length,
      serverEarnings,
      bonusWalletMilliCents
    };
  }

  async ownerEarnings(): Promise<OwnerEarningsSummary> {
    return this.earningsRepository.ownerSummary();
  }

  async bonusBalance(discordUserId: string): Promise<number> {
    return this.bonusRepository.balance(discordUserId);
  }

  async addBonus(discordUserId: string, amountMilliCents: number): Promise<number> {
    return this.bonusRepository.credit(discordUserId, amountMilliCents);
  }

  async syncConfiguredGuildOwners(): Promise<void> {
    const settings = await this.settingsRepository.list();
    await Promise.allSettled(settings.map((setting) => this.syncGuildOwner(setting.guildId, setting.ownerDiscordId)));
  }

  async guildNames(guildIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    await Promise.all(
      guildIds.map(async (guildId) => {
        const guild = await this.getGuild(guildId);
        if (guild) result.set(guildId, guild.name);
      })
    );
    return result;
  }

  async clearAllCampaigns(): Promise<ClearCampaignsSummary> {
    const deliveries = await this.adsRepository.listAllDeliveries();
    const results = await Promise.allSettled(
      deliveries.map(async (delivery) => {
        const guild = await this.getGuild(delivery.guildId);
        if (!guild) throw new Error('Serveur introuvable');
        const channel = await guild.channels.fetch(delivery.channelId);
        if (!channel?.isTextBased() || channel.isDMBased()) throw new Error('Salon introuvable');
        const message = await (channel as GuildTextBasedChannel).messages.fetch(delivery.messageId);
        await message.delete();
      })
    );
    // Les stats de campagne sont supprimées par cascade, mais le journal de gains déjà attribués reste disponible.
    const deletedCampaigns = await this.adsRepository.deleteAllCampaigns();
    return {
      deletedMessages: results.filter((result) => result.status === 'fulfilled').length,
      failedMessages: results.filter((result) => result.status === 'rejected').length,
      deletedCampaigns
    };
  }

  private async syncGuildOwner(guildId: string, savedOwnerId: string | null): Promise<void> {
    const guild = await this.getGuild(guildId);
    if (guild && guild.ownerId !== savedOwnerId) {
      await this.settingsRepository.syncOwner(guild.id, guild.ownerId);
    }
  }

  private async republishToGuild(
    ad: AdCampaign,
    guildId: string,
    channelId: string,
    previous?: AdDelivery,
    mediaSource?: AdDelivery,
    nextDelayMs = REPUBLISH_INTERVAL_MS
  ): Promise<void> {
    let previousMessage: Message | null = null;
    let media: CampaignMedia | undefined;
    const source = previous ?? mediaSource;

    if (source) {
      try {
        const guild = await this.getGuild(source.guildId);
        const oldChannel = guild ? await guild.channels.fetch(source.channelId) : null;
        if (oldChannel?.isTextBased() && !oldChannel.isDMBased()) {
          const sourceMessage = await (oldChannel as GuildTextBasedChannel).messages.fetch(source.messageId);
          if (source.id === previous?.id) previousMessage = sourceMessage;
          media = await this.mediaFromMessage(sourceMessage);
        }
      } catch (error) {
        // Une ancienne publication supprimée ne doit jamais empêcher la remise en avant de la campagne.
        console.warn(`[AdsCords] Ancienne publication introuvable pour ${ad.id} sur ${guildId}`, error);
      }
    }

    await this.publishToGuild(ad, guildId, channelId, media, nextDelayMs);
    if (previousMessage?.deletable) await previousMessage.delete().catch(() => undefined);
  }

  private async mediaFromMessage(message: Message): Promise<CampaignMedia | undefined> {
    const attachment = message.attachments.first();
    if (!attachment || attachment.size > MAX_CAMPAIGN_MEDIA_BYTES) return undefined;
    const response = await fetch(attachment.url);
    if (!response.ok) return undefined;
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CAMPAIGN_MEDIA_BYTES) return undefined;
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length === 0 || content.length > MAX_CAMPAIGN_MEDIA_BYTES || !isSupportedCampaignMedia(content)) return undefined;
    return {
      url: attachment.url,
      filename: (attachment.name ?? 'media').replace(/[^a-zA-Z0-9._-]/gu, '_') || 'media',
      content
    };
  }

  private async publishToGuild(
    ad: AdCampaign,
    guildId: string,
    channelId: string,
    media?: CampaignMedia,
    nextDelayMs = REPUBLISH_INTERVAL_MS
  ): Promise<void> {
    const guild = await this.getGuild(guildId);
    if (!guild) throw new Error(`Serveur introuvable : ${guildId}`);

    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isTextBased() || channel.isDMBased()) {
      throw new Error(`Salon de diffusion invalide : ${channelId}`);
    }

    // Un jeton neuf lie le lien à ce message précis. Une republication invalide les anciens liens.
    const deliveryToken = randomUUID();
    const trackingUrl = this.trackingUrl(ad.id, guildId, deliveryToken);
    const components = [adRow(trackingUrl, ad.destinationUrl)];
    const textChannel = channel as GuildTextBasedChannel;
    const displayAd = media ? { ...ad, mediaUrl: `attachment://${media.filename}` } : ad;

    let message;
    if (ad.useEmbed) {
      message = media
        ? await textChannel.send({
            embeds: [adEmbed(displayAd)],
            components,
            files: [{ attachment: media.content, name: media.filename }]
          })
        : await textChannel.send({ embeds: [adEmbed(displayAd)], components });
    } else {
      message = media
        ? await textChannel.send({
            content: ad.description,
            components,
            files: [{ attachment: media.content, name: media.filename }],
            allowedMentions: { parse: [] }
          })
        : await textChannel.send({ content: ad.description, components, allowedMentions: { parse: [] } });
    }

    const deliveredAtMs = Date.now();
    const nextRepublishAtMs = nextDelayMs === REPUBLISH_INTERVAL_MS
      ? nextRepublishAt(deliveredAtMs)
      : deliveredAtMs + nextDelayMs;
    try {
      await this.adsRepository.saveDelivery({
        adId: ad.id,
        guildId,
        channelId: channel.id,
        messageId: message.id,
        deliveryToken,
        nextRepublishAt: new Date(nextRepublishAtMs).toISOString()
      });
    } catch (error) {
      // Une migration Supabase manquante ne doit jamais laisser une nouvelle copie non suivie
      // dans le salon, ni déclencher une accumulation visible à chaque tentative du planificateur.
      if (message.deletable) await message.delete().catch(() => undefined);
      throw error;
    }
  }

  private trackingUrl(adId: string, guildId: string, deliveryToken: string): string {
    const url = new URL(env.trackingBaseUrl);
    url.searchParams.set('ad', adId);
    url.searchParams.set('guild', guildId);
    url.searchParams.set('t', deliveryToken);
    return url.toString();
  }

  private async getGuild(guildId: string): Promise<Guild | null> {
    return this.client.guilds.cache.get(guildId) ?? this.client.guilds.fetch(guildId).catch(() => null);
  }
}
