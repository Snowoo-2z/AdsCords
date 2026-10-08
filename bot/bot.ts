import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Guild,
  PermissionFlagsBits,
  type GuildTextBasedChannel
} from 'discord.js';

import { env } from './environment.js';
import { CommandHandler } from './command-handler.js';
import { InteractionHandler } from './interaction-handler.js';
import { AdsRepository } from './ads-repository.js';
import { EarningsRepository } from './earnings-repository.js';
import { BonusRepository } from './bonus-repository.js';
import { SettingsRepository } from './settings-repository.js';
import { CampaignService } from './campaign-service.js';
import { ConfigurationService } from './configuration-service.js';
import { welcomeEmbed } from './embeds.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const settingsRepository = new SettingsRepository();
const adsRepository = new AdsRepository();
const earningsRepository = new EarningsRepository();
const bonusRepository = new BonusRepository();
const configurationService = new ConfigurationService(settingsRepository);
const campaignService = new CampaignService(adsRepository, settingsRepository, earningsRepository, bonusRepository, client);
const commandHandler = new CommandHandler(client, configurationService, campaignService);
const interactionHandler = new InteractionHandler(configurationService, campaignService);

client.once(Events.ClientReady, (readyClient) => {
  console.info(`[AdsCords] Connecté en tant que ${readyClient.user.tag}.`);
  // Une propriété de serveur peut changer sans qu'il faille reconfigurer le salon de publicités.
  void campaignService.syncConfiguredGuildOwners().catch((error: unknown) => {
    console.error('[AdsCords] Synchronisation des propriétaires de serveurs impossible', error);
  });
  campaignService.startRepublishing();
});

client.on(Events.GuildCreate, async (guild) => {
  try {
    const channel = await findWelcomeChannel(guild);
    if (!channel) {
      console.warn(`[AdsCords] Aucun salon accueillant disponible sur ${guild.name} (${guild.id}).`);
      return;
    }
    await channel.send({ embeds: [welcomeEmbed(env.commandPrefix)] });
  } catch (error) {
    console.error(`[AdsCords] Message de bienvenue impossible sur ${guild.id}`, error);
  }
});

client.on(Events.MessageCreate, (message) => {
  void commandHandler.handle(message);
});

client.on(Events.InteractionCreate, (interaction) => {
  void interactionHandler.handle(interaction);
});

async function findWelcomeChannel(guild: Guild): Promise<GuildTextBasedChannel | null> {
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) return null;

  const candidates = [guild.systemChannel, ...guild.channels.cache.values()];
  for (const channel of candidates) {
    if (!channel || channel.type !== ChannelType.GuildText) continue;
    const permissions = channel.permissionsFor(me);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) continue;
    return channel;
  }
  return null;
}

async function shutdown(signal: string): Promise<void> {
  console.info(`[AdsCords] Arrêt demandé (${signal}).`);
  client.destroy();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

void client.login(env.discordToken).catch((error: unknown) => {
  console.error('[AdsCords] Connexion Discord impossible.', error);
  process.exitCode = 1;
});
