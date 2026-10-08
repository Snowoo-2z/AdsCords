import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  Guild,
  GuildBasedChannel,
  PermissionFlagsBits,
  User
} from 'discord.js';

import { COMPONENT_PREFIX } from './constants.js';
import { env } from './environment.js';
import { SettingsRepository } from './settings-repository.js';
import { configEmbed } from './embeds.js';

export class ConfigurationService {
  public constructor(private readonly settingsRepository: SettingsRepository) {}

  panel(userId: string): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  } {
    const chooseButton = new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX.configPick}${userId}`)
      .setLabel('Choisir un salon')
      .setStyle(ButtonStyle.Primary);
    const createButton = new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX.configCreate}${userId}`)
      .setLabel('Créer #ads-cords')
      .setStyle(ButtonStyle.Secondary);

    return {
      embeds: [configEmbed(env.commandPrefix)],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(chooseButton, createButton)]
    };
  }

  selector(userId: string): {
    content: string;
    components: ActionRowBuilder<ChannelSelectMenuBuilder>[];
  } {
    const select = new ChannelSelectMenuBuilder()
      .setCustomId(`${COMPONENT_PREFIX.configSelect}${userId}`)
      .setPlaceholder('Sélectionnez le salon des publicités')
      .setChannelTypes(ChannelType.GuildText)
      .setMinValues(1)
      .setMaxValues(1);

    return {
      content: 'Choisissez le salon de diffusion :',
      components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select)]
    };
  }

  isPanelOwner(customId: string, user: User): boolean {
    const ownerId = customId.split(':').at(-1);
    return ownerId === user.id;
  }

  async saveChannel(guild: Guild, channel: GuildBasedChannel): Promise<void> {
    if (channel.type !== ChannelType.GuildText) {
      throw new Error('Le salon sélectionné doit être un salon textuel classique.');
    }
    // Le propriétaire Discord du serveur est le bénéficiaire de la part serveur des clics.
    await this.settingsRepository.save(guild.id, channel.id, guild.ownerId);
  }

  async createChannel(guild: Guild): Promise<GuildBasedChannel> {
    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      throw new Error('La permission « Gérer les salons » est requise pour créer #ads-cords.');
    }

    const existing = guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildText && channel.name === env.autoChannelName
    );
    if (existing) return existing;

    return guild.channels.create({
      name: env.autoChannelName,
      type: ChannelType.GuildText,
      reason: 'Configuration AdsCords'
    });
  }
}
