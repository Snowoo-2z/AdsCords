import { Client, EmbedBuilder, Message, PermissionFlagsBits } from 'discord.js';

import { COMPONENT_PREFIX } from './constants.js';
import { env } from './environment.js';
import { CampaignService, MAX_CAMPAIGN_MEDIA_BYTES } from './campaign-service.js';
import { ConfigurationService } from './configuration-service.js';
import { clickGuardEmbed, clickGuardRow, clickLogsEmbed, helpEmbed, newAdEmbed } from './embeds.js';
import { parsePrefixCommand } from './commands.js';
import { createMapubDashboardPng } from './mapub-image.js';
import { createEarningsDashboardPng, createOwnerDashboardPng, createProfileDashboardPng } from './account-image.js';
import { euroToCents, formatBonusCreditsFromMilliCents } from './currency.js';

export class CommandHandler {
  public constructor(
    private readonly client: Client,
    private readonly configurationService: ConfigurationService,
    private readonly campaignService: CampaignService
  ) {}

  async handle(message: Message): Promise<void> {
    if (message.author.bot) return;

    try {
      if (await this.consumePendingMedia(message)) return;

      const parsed = parsePrefixCommand(message.content, env.commandPrefix);
      if (!parsed) return;
      switch (parsed.command) {
        case 'help':
        case 'aide':
          await this.handleHelp(message, parsed.args);
          return;
        case 'config':
          await this.handleConfig(message);
          return;
        case 'new_pub':
          await this.handleNewPub(message);
          return;
        case 'mapub':
          await this.handleMapub(message);
          return;
        case 'mesgains':
          await this.handleMyEarnings(message);
          return;
        case 'profile':
        case 'profil':
          await this.handleProfile(message);
          return;
        case 'owner':
          await this.handleOwner(message);
          return;
        case 'add_bonus':
        case 'ajout_bonus':
          await this.handleAddBonus(message, parsed.args);
          return;
        case 'bonus':
          await this.handleBonus(message, parsed.args);
          return;
        case 'click_guard':
          await this.handleClickGuard(message);
          return;
        case 'click_logs':
          await this.handleClickLogs(message, parsed.args);
          return;
        case 'clear_pubs':
        case 'delete_pubs':
          await this.handleClearPubs(message);
          return;
        default:
          return;
      }
    } catch (error) {
      console.error('[AdsCords] Commande impossible à traiter', error);
      await this.replySafely(message, '❌ Une erreur est survenue. Vérifiez la configuration Supabase et les permissions du bot.');
    }
  }

  private async consumePendingMedia(message: Message): Promise<boolean> {
    if (message.author.id !== env.botOwnerId || message.attachments.size === 0) return false;

    const media = message.attachments.find((attachment) => {
      const contentType = attachment.contentType ?? '';
      const name = attachment.name ?? attachment.url;
      return /^(image\/(avif|gif|jpeg|png|webp))$/iu.test(contentType) || /\.(apng|avif|gif|jpe?g|png|webp)$/iu.test(name);
    });
    if (!media) return false;
    if (media.size > MAX_CAMPAIGN_MEDIA_BYTES) {
      await this.replySafely(message, '❌ Le visuel dépasse la limite de 8 Mo. Envoie une image ou un GIF plus léger.');
      return true;
    }

    let result;
    try {
      result = await this.campaignService.publishDraftFromAttachment(message.author.id, message.channelId, media.url, media.name ?? 'media');
    } catch (error) {
      if (error instanceof Error && error.message.includes('BONUS_BALANCE_INSUFFICIENT')) {
        await this.replySafely(message, '❌ Le solde de crédits bonus du propriétaire de cette campagne est insuffisant. Aucun crédit n’a été retiré.');
        return true;
      }
      if (error instanceof Error && (error.message.includes('visuel') || error.message.includes('image PNG'))) {
        await this.replySafely(message, `❌ ${error.message}`);
        return true;
      }
      throw error;
    }
    if (!result) return false;

    const warning = result.summary.failed > 0 ? ` ${result.summary.failed} diffusion(s) ont échoué.` : '';
    const bonusDebit = result.campaign.rewardType === 'bonus'
      ? ` **${formatBonusCreditsFromMilliCents(result.campaign.initialCreditsCents * 1_000)}** ont été débités du portefeuille bonus de \`${result.campaign.ownerDiscordId}\`.`
      : '';
    await this.replySafely(
      message,
      `✅ Image/GIF reçu. Campagne créée et diffusée dans **${result.summary.sent}** serveur(s).${bonusDebit}${warning}`
    );
    if (message.deletable) await message.delete().catch(() => undefined);
    return true;
  }

  private async handleHelp(message: Message, args: string[]): Promise<void> {
    if (args[0]?.toLowerCase() === 'serveurs' && message.author.id === env.botOwnerId) {
      const guilds = [...this.client.guilds.cache.values()];
      const names = guilds.slice(0, 25).map((guild) => `• ${guild.name} (\`${guild.id}\`)`).join('\n') || 'Aucun serveur';
      const suffix = guilds.length > 25 ? `\n… et ${guilds.length - 25} autre(s).` : '';
      await this.replySafely(message, { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Serveurs AdsCords').setDescription(`${names}${suffix}`)] });
      return;
    }

    await this.replySafely(message, { embeds: [helpEmbed(env.commandPrefix)] });
  }

  private async handleConfig(message: Message): Promise<void> {
    if (!message.guild) {
      await this.replySafely(message, '❌ La configuration doit être réalisée depuis un serveur Discord.');
      return;
    }
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await this.replySafely(message, '❌ Vous devez avoir la permission **Gérer le serveur** pour configurer AdsCords.');
      return;
    }
    await this.replySafely(message, this.configurationService.panel(message.author.id));
  }

  private async handleNewPub(message: Message): Promise<void> {
    if (message.author.id !== env.botOwnerId) {
      await this.replySafely(message, '❌ Cette commande est réservée au propriétaire d’AdsCords.');
      return;
    }
    await this.replySafely(message, {
      embeds: [newAdEmbed()],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              label: 'Créer une campagne',
              custom_id: `pub:open:${message.author.id}`
            }
          ]
        }
      ]
    });
  }

  private async handleMapub(message: Message): Promise<void> {
    if (message.guildId !== env.mapubGuildId) {
      await this.replySafely(message, '❌ La commande `.mapub` est disponible uniquement sur le serveur autorisé.');
      return;
    }

    // Le propriétaire du bot conserve la vue générale ; un annonceur ne voit que ses propres campagnes.
    const ownerFilter = message.author.id === env.botOwnerId ? undefined : message.author.id;
    const campaigns = await this.campaignService.dashboard(ownerFilter);
    const title = ownerFilter ? 'MES CAMPAGNES' : 'TOUTES LES CAMPAGNES';
    await this.replySafely(message, {
      files: [{ attachment: createMapubDashboardPng(campaigns, title), name: 'mapub-dashboard.png' }]
    });
  }

  private async handleMyEarnings(message: Message): Promise<void> {
    const earnings = await this.campaignService.earnings(message.author.id);
    const names = await this.campaignService.guildNames(earnings.guilds.map((guild) => guild.guildId));
    await this.replySafely(message, {
      files: [{ attachment: createEarningsDashboardPng(earnings, names), name: 'mes-gains.png' }]
    });
  }

  private async handleProfile(message: Message): Promise<void> {
    const summary = await this.campaignService.profile(message.author.id);
    await this.replySafely(message, {
      files: [{ attachment: createProfileDashboardPng(summary), name: 'profile-adscords.png' }]
    });
  }

  private async handleOwner(message: Message): Promise<void> {
    if (message.author.id !== env.botOwnerId) {
      await this.replySafely(message, '❌ Cette commande est réservée au propriétaire d’AdsCords.');
      return;
    }
    const summary = await this.campaignService.ownerEarnings();
    await this.replySafely(message, {
      files: [{ attachment: createOwnerDashboardPng(summary), name: 'espace-proprietaire-adscords.png' }]
    });
  }

  private async handleAddBonus(message: Message, args: string[]): Promise<void> {
    if (message.author.id !== env.botOwnerId) {
      await this.replySafely(message, '❌ Seul le propriétaire d’AdsCords peut ajouter des crédits bonus.');
      return;
    }
    const targetId = this.discordUserId(args[0] ?? '');
    const amountCents = euroToCents(args[1] ?? '');
    if (!targetId || !amountCents || !Number.isSafeInteger(amountCents * 1_000)) {
      await this.replySafely(message, `❌ Utilisation : \`${env.commandPrefix}add_bonus @utilisateur 10,50\` ou \`${env.commandPrefix}add_bonus ID 10,50\`.`);
      return;
    }
    const balance = await this.campaignService.addBonus(targetId, amountCents * 1_000);
    await this.replySafely(
      message,
      `✅ **${formatBonusCreditsFromMilliCents(amountCents * 1_000)}** ajoutés à \`${targetId}\`. Nouveau solde : **${formatBonusCreditsFromMilliCents(balance)}**.`
    );
  }

  private async handleBonus(message: Message, args: string[]): Promise<void> {
    const requestedId = args[0] ? this.discordUserId(args[0]) : message.author.id;
    if (!requestedId) {
      await this.replySafely(message, `❌ Utilisation : \`${env.commandPrefix}bonus\` ou \`${env.commandPrefix}bonus @utilisateur\`.`);
      return;
    }
    if (requestedId !== message.author.id && message.author.id !== env.botOwnerId) {
      await this.replySafely(message, '❌ Vous pouvez uniquement consulter votre propre solde bonus.');
      return;
    }
    const balance = await this.campaignService.bonusBalance(requestedId);
    const label = requestedId === message.author.id ? 'Votre solde' : `Solde de \`${requestedId}\``;
    await this.replySafely(message, `✨ ${label} est de **${formatBonusCreditsFromMilliCents(balance)}**.`);
  }

  private async handleClickGuard(message: Message): Promise<void> {
    if (message.author.id !== env.botOwnerId) {
      await this.replySafely(message, '❌ Cette commande est réservée au propriétaire d’AdsCords.');
      return;
    }
    const settings = await this.campaignService.clickGuardSettings();
    await this.replySafely(message, {
      embeds: [clickGuardEmbed(settings)],
      components: [clickGuardRow(message.author.id)]
    });
  }

  private async handleClearPubs(message: Message): Promise<void> {
    if (message.author.id !== env.botOwnerId) {
      await this.replySafely(message, '❌ Cette commande est réservée au propriétaire d’AdsCords.');
      return;
    }
    await this.replySafely(message, {
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('Supprimer toutes les publicités')
          .setDescription('Cette action supprime définitivement tous les messages, campagnes et statistiques associées. Les gains déjà attribués aux propriétaires de serveurs restent dans leur historique.')
      ],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 4,
              label: 'Confirmer la suppression globale',
              custom_id: `${COMPONENT_PREFIX.clearPubsConfirm}${message.author.id}`
            }
          ]
        }
      ]
    });
  }

  private async handleClickLogs(message: Message, args: string[]): Promise<void> {
    if (message.author.id !== env.botOwnerId) {
      await this.replySafely(message, '❌ Cette commande est réservée au propriétaire d’AdsCords.');
      return;
    }
    const requested = Number.parseInt(args[0] ?? '12', 10);
    const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 20) : 12;
    const logs = await this.campaignService.recentClickLogs(limit);
    await this.replySafely(message, { embeds: [clickLogsEmbed(logs)] });
  }

  private discordUserId(value: string): string | null {
    const match = /^(?:<@!?(\d{15,25})>|(\d{15,25}))$/u.exec(value.trim());
    return match?.[1] ?? match?.[2] ?? null;
  }

  private async replySafely(message: Message, options: Parameters<Message['reply']>[0]): Promise<void> {
    await message.reply({ ...((typeof options === 'string' ? { content: options } : options) as object), allowedMentions: { repliedUser: false } });
  }
}
