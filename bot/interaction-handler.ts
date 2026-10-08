import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import type { ChannelSelectMenuInteraction, Interaction, ModalSubmitInteraction } from 'discord.js';
import type { CampaignRewardType, ClickGuardSettings } from './domain.js';

import { COMPONENT_PREFIX } from './constants.js';
import { env } from './environment.js';
import { CampaignService } from './campaign-service.js';
import { ConfigurationService } from './configuration-service.js';
import { destinationRow } from './embeds.js';
import { euroToCents, formatBonusCreditsFromMilliCents, formatEuro } from './currency.js';

const URL_INPUT_ID = 'pub:url';
const DESCRIPTION_INPUT_ID = 'pub:description';
const BUDGET_INPUT_ID = 'pub:budget';
const DURATION_INPUT_ID = 'pub:duration';
const CAMPAIGN_OWNER_INPUT_ID = 'pub:owner';
const GUARD_FIRST_INPUT_ID = 'guard:first';
const GUARD_REPEAT_INPUT_ID = 'guard:repeat';
const GUARD_DAILY_INPUT_ID = 'guard:daily';
const GUARD_DAYS_INPUT_ID = 'guard:days';
const GUARD_SUSPENSION_INPUT_ID = 'guard:suspension';
const OPTION_LIFETIME_MS = 10 * 60 * 1000;

interface PendingCampaignOptions {
  campaignOwnerDiscordId: string;
  channelId: string;
  destinationUrl: string;
  description: string;
  durationDays: number;
  creditsCents: number;
  expiresAt: number;
}

export class InteractionHandler {
  public constructor(
    private readonly configurationService: ConfigurationService,
    private readonly campaignService: CampaignService
  ) {}

  private readonly pendingCampaignOptions = new Map<string, PendingCampaignOptions>();

  async handle(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isButton()) {
        await this.handleButton(interaction);
        return;
      }
      if (interaction.isChannelSelectMenu()) {
        await this.handleChannelSelect(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId === COMPONENT_PREFIX.adModal) {
        await this.handleAdModal(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId === COMPONENT_PREFIX.clickGuardModal) {
        await this.handleClickGuardModal(interaction);
      }
    } catch (error) {
      console.error('[AdsCords] Interaction impossible à traiter', error);
      await this.reportError(interaction, error);
    }
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const { customId } = interaction;
    if (customId.startsWith(COMPONENT_PREFIX.configPick)) {
      if (!this.configurationService.isPanelOwner(customId, interaction.user)) {
        await interaction.reply({ content: '❌ Ce panneau de configuration ne vous appartient pas.', ephemeral: true });
        return;
      }
      if (!this.canManageGuild(interaction)) {
        await interaction.reply({ content: '❌ Vous devez avoir la permission **Gérer le serveur**.', ephemeral: true });
        return;
      }
      await interaction.update(this.configurationService.selector(interaction.user.id));
      return;
    }

    if (customId.startsWith(COMPONENT_PREFIX.configCreate)) {
      if (!this.configurationService.isPanelOwner(customId, interaction.user)) {
        await interaction.reply({ content: '❌ Ce panneau de configuration ne vous appartient pas.', ephemeral: true });
        return;
      }
      if (!interaction.guild || !this.canManageGuild(interaction)) {
        await interaction.reply({ content: '❌ Vous devez avoir la permission **Gérer le serveur**.', ephemeral: true });
        return;
      }
      await interaction.deferUpdate();
      const channel = await this.configurationService.createChannel(interaction.guild);
      await this.configurationService.saveChannel(interaction.guild, channel);
      const summary = await this.publishConfiguredGuild(interaction.guild.id);
      await interaction.editReply({
        content: this.configurationMessage(channel.id, summary),
        embeds: [],
        components: []
      });
      return;
    }

    if (customId.startsWith(COMPONENT_PREFIX.clearPubsConfirm)) {
      if (interaction.user.id !== env.botOwnerId) {
        await interaction.reply({ content: '❌ Seul le propriétaire d’AdsCords peut supprimer les publicités.', ephemeral: true });
        return;
      }
      await interaction.deferUpdate();
      const summary = await this.campaignService.clearAllCampaigns();
      const failures = summary.failedMessages > 0 ? ` ${summary.failedMessages} message(s) n’ont pas pu être supprimés.` : '';
      await interaction.editReply({
        content: `✅ ${summary.deletedMessages} message(s) publicitaire(s) supprimé(s). ${summary.deletedCampaigns} campagne(s) effacée(s). Les gains déjà attribués aux serveurs sont conservés.${failures}`,
        embeds: [],
        components: []
      });
      return;
    }

    if (customId.startsWith(COMPONENT_PREFIX.clickGuardOpen)) {
      if (interaction.user.id !== env.botOwnerId) {
        await interaction.reply({ content: '❌ Seul le propriétaire d’AdsCords peut modifier cette protection.', ephemeral: true });
        return;
      }
      const settings = await this.campaignService.clickGuardSettings();
      await interaction.showModal(this.clickGuardModal(settings));
      return;
    }

    if (customId.startsWith(COMPONENT_PREFIX.adOptions)) {
      await this.handleCampaignOptions(interaction);
      return;
    }

    if (customId.startsWith(COMPONENT_PREFIX.adSkipMedia)) {
      if (interaction.user.id !== env.botOwnerId) {
        await interaction.reply({ content: '❌ Seul le propriétaire d’AdsCords peut publier cette campagne.', ephemeral: true });
        return;
      }
      await interaction.deferUpdate();
      const result = await this.campaignService.publishDraft(interaction.user.id, null);
      if (!result) {
        await interaction.editReply({ content: '⌛ Cette préparation a expiré. Lancez de nouveau `.new_pub`.', components: [] });
        return;
      }
      await interaction.editReply({ content: this.draftPublishedMessage(result.summary, false, result.campaign), components: [] });
      return;
    }

    if (customId.startsWith(COMPONENT_PREFIX.adPanel)) {
      if (interaction.user.id !== env.botOwnerId) {
        await interaction.reply({ content: '❌ Seul le propriétaire d’AdsCords peut créer une campagne.', ephemeral: true });
        return;
      }
      await interaction.showModal(this.newCampaignModal());
      return;
    }

    // Compatibilité avec les boutons créés avant la redirection directe par lien.
    if (customId.startsWith(COMPONENT_PREFIX.adVisit)) {
      await this.handleAdClick(interaction);
    }
  }

  private async handleCampaignOptions(interaction: ButtonInteraction): Promise<void> {
    if (interaction.user.id !== env.botOwnerId) {
      await interaction.reply({ content: '❌ Seul le propriétaire d’AdsCords peut créer une campagne.', ephemeral: true });
      return;
    }
    const [, , rawRewardType, rawDisplay, expectedUserId] = interaction.customId.split(':');
    if (expectedUserId !== interaction.user.id || !['cash', 'bonus'].includes(rawRewardType ?? '') || !['embed', 'plain'].includes(rawDisplay ?? '')) {
      await interaction.reply({ content: '❌ Ce choix de campagne est invalide.', ephemeral: true });
      return;
    }
    const pending = this.pendingCampaignOptions.get(interaction.user.id);
    if (!pending || pending.expiresAt < Date.now()) {
      this.pendingCampaignOptions.delete(interaction.user.id);
      await interaction.update({ content: '⌛ Cette préparation a expiré. Lancez de nouveau `.new_pub`.', components: [] });
      return;
    }
    this.pendingCampaignOptions.delete(interaction.user.id);
    const rewardType = rawRewardType as CampaignRewardType;
    const useEmbed = rawDisplay === 'embed';
    this.campaignService.startDraft({
      creatorDiscordId: interaction.user.id,
      campaignOwnerDiscordId: pending.campaignOwnerDiscordId,
      channelId: pending.channelId,
      destinationUrl: pending.destinationUrl,
      description: pending.description,
      useEmbed,
      rewardType,
      durationDays: pending.durationDays,
      creditsCents: pending.creditsCents,
      clickCostCents: env.clickCostCents
    });

    const typeLabel = rewardType === 'bonus' ? 'crédits bonus' : 'euros réels';
    const durationLabel = pending.durationDays === 0
      ? 'sans durée, jusqu’à épuisement du budget'
      : `sur ${pending.durationDays} jour${pending.durationDays > 1 ? 's' : ''}`;
    await interaction.update({
      content:
        `✅ Campagne **${typeLabel}** ${durationLabel} préparée.\n` +
        '📎 Envoie maintenant **l’image ou le GIF en pièce jointe dans ce salon**. La campagne sera publiée dès la réception.\n' +
        'Tu as 10 minutes. Tu peux aussi publier immédiatement sans visuel :',
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${COMPONENT_PREFIX.adSkipMedia}${interaction.user.id}`)
            .setStyle(ButtonStyle.Secondary)
            .setLabel('Publier sans visuel')
        )
      ]
    });
  }

  private async handleChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
    if (!this.configurationService.isPanelOwner(interaction.customId, interaction.user)) {
      await interaction.reply({ content: '❌ Ce panneau de configuration ne vous appartient pas.', ephemeral: true });
      return;
    }
    if (!interaction.guild || !this.canManageGuild(interaction)) {
      await interaction.reply({ content: '❌ Vous devez avoir la permission **Gérer le serveur**.', ephemeral: true });
      return;
    }

    const selectedId = interaction.values[0];
    if (!selectedId) {
      await interaction.reply({ content: '❌ Aucun salon sélectionné.', ephemeral: true });
      return;
    }
    const channel = await interaction.guild.channels.fetch(selectedId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: '❌ Sélectionnez un salon textuel classique.', ephemeral: true });
      return;
    }

    await this.configurationService.saveChannel(interaction.guild, channel);
    const summary = await this.publishConfiguredGuild(interaction.guild.id);
    await interaction.update({
      content: this.configurationMessage(channel.id, summary),
      embeds: [],
      components: []
    });
  }

  private async handleAdModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.user.id !== env.botOwnerId) {
      await interaction.reply({ content: '❌ Seul le propriétaire d’AdsCords peut créer une campagne.', ephemeral: true });
      return;
    }

    const rawUrl = interaction.fields.getTextInputValue(URL_INPUT_ID).trim();
    const description = interaction.fields.getTextInputValue(DESCRIPTION_INPUT_ID).trim();
    const campaignOwnerId = interaction.fields.getTextInputValue(CAMPAIGN_OWNER_INPUT_ID).trim();
    const budget = euroToCents(interaction.fields.getTextInputValue(BUDGET_INPUT_ID));
    const durationDays = this.campaignDuration(interaction.fields.getTextInputValue(DURATION_INPUT_ID));
    if (!this.isHttpUrl(rawUrl)) {
      await interaction.reply({ content: '❌ Le lien doit commencer par `https://` ou `http://`.', ephemeral: true });
      return;
    }
    if (!description) {
      await interaction.reply({ content: '❌ La description ne peut pas être vide.', ephemeral: true });
      return;
    }
    if (!this.isDiscordUserId(campaignOwnerId)) {
      await interaction.reply({ content: '❌ Indiquez un ID Discord utilisateur valide (uniquement les chiffres).', ephemeral: true });
      return;
    }
    if (durationDays === null) {
      await interaction.reply({ content: '❌ Indiquez un nombre entier entre 1 et 365, ou `illimité` pour diffuser jusqu’à épuisement du budget.', ephemeral: true });
      return;
    }
    const clickSettings = await this.campaignService.clickGuardSettings();
    const minimumDailyBudget = Math.max(clickSettings.firstDailyClickCents, clickSettings.repeatClickMinCents);
    const minimumBudget = durationDays === 0 ? minimumDailyBudget : durationDays * minimumDailyBudget;
    if (!budget || budget < minimumBudget) {
      const reason = durationDays === 0
        ? 'pour permettre au moins un clic valorisé'
        : `pour répartir ${durationDays} jour(s) de clics`;
      await interaction.reply({
        content: `❌ Le budget doit couvrir au minimum ${formatEuro(minimumBudget)} ${reason}.`,
        ephemeral: true
      });
      return;
    }
    if (!interaction.channelId) {
      await interaction.reply({ content: '❌ Impossible de préparer l’envoi du visuel dans ce canal.', ephemeral: true });
      return;
    }

    this.pendingCampaignOptions.set(interaction.user.id, {
      campaignOwnerDiscordId: campaignOwnerId,
      channelId: interaction.channelId,
      destinationUrl: rawUrl,
      description,
      durationDays,
      creditsCents: budget,
      expiresAt: Date.now() + OPTION_LIFETIME_MS
    });
    await interaction.reply({
      content:
        `Choisis le **type de récompense** puis le **mode d’affichage**. Le budget de ${formatEuro(budget)} sera réparti automatiquement sur ${durationDays} jour${durationDays > 1 ? 's' : ''}.\n` +
        '• **€** : le serveur reçoit 30 % en euros, AdsCords conserve 70 %.\n' +
        '• **Bonus** : le serveur reçoit 70 % en crédits bonus dédiés aux publicités ; 30 % sont brûlés.',
      components: this.campaignOptionRows(interaction.user.id),
      ephemeral: true
    });
  }

  private async handleClickGuardModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.user.id !== env.botOwnerId) {
      await interaction.reply({ content: '❌ Seul le propriétaire d’AdsCords peut modifier cette protection.', ephemeral: true });
      return;
    }

    const first = this.firstValueRule(interaction.fields.getTextInputValue(GUARD_FIRST_INPUT_ID));
    const repeat = this.centsRange(interaction.fields.getTextInputValue(GUARD_REPEAT_INPUT_ID));
    const dailyThreshold = this.integerInRange(interaction.fields.getTextInputValue(GUARD_DAILY_INPUT_ID), 2, 100);
    const suspiciousDays = this.integerInRange(interaction.fields.getTextInputValue(GUARD_DAYS_INPUT_ID), 1, 7);
    const suspensionDays = this.integerInRange(interaction.fields.getTextInputValue(GUARD_SUSPENSION_INPUT_ID), 1, 30);

    if (!first || !repeat || !dailyThreshold || !suspiciousDays || !suspensionDays) {
      await interaction.reply({
        content: '❌ Valeurs invalides. Premier clic : `10/3` ; autres clics : une plage comme `2-4`.',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const settings = await this.campaignService.saveClickGuardSettings({
      firstDailyClickCents: first.cents,
      firstValueCooldownDays: first.cooldownDays,
      repeatClickMinCents: repeat.min,
      repeatClickMaxCents: repeat.max,
      suspiciousClicksPerDay: dailyThreshold,
      suspiciousDaysRequired: suspiciousDays,
      suspensionDays
    });
    await interaction.editReply(
      `✅ Protection mise à jour : ${formatEuro(settings.firstDailyClickCents)} une fois tous les ${settings.firstValueCooldownDays} jours, puis ${formatEuro(settings.repeatClickMinCents)} à ${formatEuro(settings.repeatClickMaxCents)}.\n` +
        `Blocage : ${settings.suspiciousClicksPerDay} pubs/jour pendant ${settings.suspiciousDaysRequired} jour(s) sur 7 → ${settings.suspensionDays} jour(s).`
    );
  }

  private async handleAdClick(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ Cette publicité doit être ouverte depuis un serveur.', ephemeral: true });
      return;
    }
    const adId = interaction.customId.slice(COMPONENT_PREFIX.adVisit.length);
    await interaction.deferReply({ ephemeral: true });
    const result = await this.campaignService.registerClick(adId, interaction.user.id, interaction.guildId);

    if ((result.status === 'charged' || result.status === 'already_clicked') && result.destinationUrl) {
      await interaction.editReply({ content: '✅ Ouvre le lien ci-dessous.', components: [destinationRow(result.destinationUrl)] });
      return;
    }
    await interaction.editReply({ content: 'ℹ️ Cette campagne n’est pas disponible pour le moment.', components: [] });
  }

  private async publishConfiguredGuild(guildId: string): Promise<{ sent: number; failed: number } | null> {
    try {
      return await this.campaignService.publishActiveToGuild(guildId);
    } catch (error) {
      // La configuration doit rester réussie même si une ancienne campagne ne peut pas être remise en avant.
      console.error('[AdsCords] Publication immédiate après .config impossible', error);
      return null;
    }
  }

  private configurationMessage(channelId: string, summary: { sent: number; failed: number } | null): string {
    const base = `✅ Les publicités seront désormais diffusées dans <#${channelId}>.`;
    if (!summary) return `${base} Les campagnes actives seront réessayées automatiquement.`;
    if (summary.sent === 0 && summary.failed === 0) return `${base} Aucune campagne active n’est à diffuser actuellement.`;
    const failures = summary.failed > 0 ? ` ${summary.failed} campagne(s) seront réessayées automatiquement.` : '';
    return `${base} ${summary.sent} campagne(s) active(s) ont été publiées immédiatement.${failures}`;
  }

  private campaignOptionRows(userId: string): ActionRowBuilder<ButtonBuilder>[] {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${COMPONENT_PREFIX.adOptions}cash:embed:${userId}`)
          .setStyle(ButtonStyle.Primary)
          .setLabel('€ • Avec embed'),
        new ButtonBuilder()
          .setCustomId(`${COMPONENT_PREFIX.adOptions}cash:plain:${userId}`)
          .setStyle(ButtonStyle.Secondary)
          .setLabel('€ • Message simple')
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${COMPONENT_PREFIX.adOptions}bonus:embed:${userId}`)
          .setStyle(ButtonStyle.Success)
          .setLabel('Bonus • Avec embed'),
        new ButtonBuilder()
          .setCustomId(`${COMPONENT_PREFIX.adOptions}bonus:plain:${userId}`)
          .setStyle(ButtonStyle.Success)
          .setLabel('Bonus • Message simple')
      )
    ];
  }

  private draftPublishedMessage(
    summary: { sent: number; failed: number },
    withMedia: boolean,
    campaign: { rewardType: CampaignRewardType; initialCreditsCents: number; ownerDiscordId: string }
  ): string {
    const warning = summary.failed > 0 ? ` ${summary.failed} diffusion(s) ont échoué (salon supprimé ou permissions manquantes).` : '';
    const media = withMedia ? ' avec le visuel joint' : ' sans visuel';
    const bonusDebit = campaign.rewardType === 'bonus'
      ? ` **${formatBonusCreditsFromMilliCents(campaign.initialCreditsCents * 1_000)}** ont été débités du portefeuille bonus de \`${campaign.ownerDiscordId}\`.`
      : '';
    return `✅ Campagne créée${media}. Diffusée dans **${summary.sent}** serveur(s).${bonusDebit}${warning}`;
  }

  private clickGuardModal(settings: ClickGuardSettings): ModalBuilder {
    const first = new TextInputBuilder()
      .setCustomId(GUARD_FIRST_INPUT_ID)
      .setLabel('Premier clic : centimes/jours')
      .setPlaceholder('Ex. 10/3')
      .setStyle(TextInputStyle.Short)
      .setValue(`${settings.firstDailyClickCents}/${settings.firstValueCooldownDays}`)
      .setRequired(true)
      .setMaxLength(8);
    const repeat = new TextInputBuilder()
      .setCustomId(GUARD_REPEAT_INPUT_ID)
      .setLabel('Autres clics : minimum-maximum (CT)')
      .setStyle(TextInputStyle.Short)
      .setValue(`${settings.repeatClickMinCents}-${settings.repeatClickMaxCents}`)
      .setRequired(true)
      .setMaxLength(11);
    const daily = new TextInputBuilder()
      .setCustomId(GUARD_DAILY_INPUT_ID)
      .setLabel('Publicités/jour avant signalement')
      .setStyle(TextInputStyle.Short)
      .setValue(String(settings.suspiciousClicksPerDay))
      .setRequired(true)
      .setMaxLength(3);
    const days = new TextInputBuilder()
      .setCustomId(GUARD_DAYS_INPUT_ID)
      .setLabel('Jours signalés requis (fenêtre 7 jours)')
      .setStyle(TextInputStyle.Short)
      .setValue(String(settings.suspiciousDaysRequired))
      .setRequired(true)
      .setMaxLength(1);
    const suspension = new TextInputBuilder()
      .setCustomId(GUARD_SUSPENSION_INPUT_ID)
      .setLabel('Durée du blocage (jours)')
      .setStyle(TextInputStyle.Short)
      .setValue(String(settings.suspensionDays))
      .setRequired(true)
      .setMaxLength(2);

    return new ModalBuilder()
      .setCustomId(COMPONENT_PREFIX.clickGuardModal)
      .setTitle('Protection des clics')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(first),
        new ActionRowBuilder<TextInputBuilder>().addComponents(repeat),
        new ActionRowBuilder<TextInputBuilder>().addComponents(daily),
        new ActionRowBuilder<TextInputBuilder>().addComponents(days),
        new ActionRowBuilder<TextInputBuilder>().addComponents(suspension)
      );
  }

  private newCampaignModal(): ModalBuilder {
    const url = new TextInputBuilder()
      .setCustomId(URL_INPUT_ID)
      .setLabel('Lien de destination')
      .setPlaceholder('https://exemple.fr')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(500);
    const description = new TextInputBuilder()
      .setCustomId(DESCRIPTION_INPUT_ID)
      .setLabel('Description de la publicité')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1000);
    const campaignOwner = new TextInputBuilder()
      .setCustomId(CAMPAIGN_OWNER_INPUT_ID)
      .setLabel('ID Discord du propriétaire de la pub')
      .setPlaceholder('Ex. 1554498783172235345')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(25);
    const duration = new TextInputBuilder()
      .setCustomId(DURATION_INPUT_ID)
      .setLabel('Durée : jours ou illimité')
      .setPlaceholder('Ex. 7 ou illimité')
      .setStyle(TextInputStyle.Short)
      .setValue('illimité')
      .setRequired(true)
      .setMaxLength(12);
    const budget = new TextInputBuilder()
      .setCustomId(BUDGET_INPUT_ID)
      .setLabel('Budget total en euros')
      .setPlaceholder('Ex. 10,50')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(12);

    return new ModalBuilder()
      .setCustomId(COMPONENT_PREFIX.adModal)
      .setTitle('Créer une publicité')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(url),
        new ActionRowBuilder<TextInputBuilder>().addComponents(description),
        new ActionRowBuilder<TextInputBuilder>().addComponents(campaignOwner),
        new ActionRowBuilder<TextInputBuilder>().addComponents(duration),
        new ActionRowBuilder<TextInputBuilder>().addComponents(budget)
      );
  }

  private canManageGuild(interaction: ButtonInteraction | ChannelSelectMenuInteraction): boolean {
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  }

  private isDiscordUserId(value: string): boolean {
    return /^\d{15,25}$/u.test(value);
  }

  private campaignDuration(value: string): number | null {
    const normalized = value.trim().toLocaleLowerCase('fr-FR');
    if (['illimité', 'illimite', 'sans durée', 'sans duree', 'infini', 'infinite', '0'].includes(normalized)) return 0;
    return this.integerInRange(normalized, 1, 365);
  }

  private integerInRange(value: string, min: number, max: number): number | null {
    const normalized = value.trim();
    if (!/^\d+$/u.test(normalized)) return null;
    const parsed = Number.parseInt(normalized, 10);
    return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
  }

  private firstValueRule(value: string): { cents: number; cooldownDays: number } | null {
    const match = /^(\d+)\s*\/\s*(\d+)$/u.exec(value.trim());
    if (!match) return null;
    const cents = this.integerInRange(match[1] ?? '', 1, 10_000);
    const cooldownDays = this.integerInRange(match[2] ?? '', 1, 30);
    return cents && cooldownDays ? { cents, cooldownDays } : null;
  }

  private centsRange(value: string): { min: number; max: number } | null {
    const match = /^(\d+)\s*-\s*(\d+)$/u.exec(value.trim());
    if (!match) return null;
    const min = this.integerInRange(match[1] ?? '', 1, 10_000);
    const max = this.integerInRange(match[2] ?? '', 1, 10_000);
    return min && max && min <= max ? { min, max } : null;
  }

  private isHttpUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }

  private async reportError(interaction: Interaction, error: unknown): Promise<void> {
    const content = error instanceof Error && error.message.includes('BONUS_BALANCE_INSUFFICIENT')
      ? '❌ Le solde de crédits bonus du propriétaire de cette campagne est insuffisant. Aucun crédit n’a été retiré.'
      : '❌ Une erreur est survenue. Vérifiez la configuration Supabase et réessayez.';
    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true }).catch(() => undefined);
      } else {
        await interaction.reply({ content, ephemeral: true }).catch(() => undefined);
      }
    }
  }
}
