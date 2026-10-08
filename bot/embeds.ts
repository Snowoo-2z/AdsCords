import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

import { COMPONENT_PREFIX } from './constants.js';
import type { AdCampaign, CampaignDashboardItem, ClickGuardSettings, ClickLogEntry } from './domain.js';
import { formatEuro, progressBar } from './currency.js';

export function welcomeEmbed(prefix: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Bienvenue sur AdsCords')
    .setDescription(
      `Merci de m'avoir ajouté. Pour choisir le salon de diffusion, utilisez **\`${prefix}config\`**.\n` +
        `Toutes les commandes sont disponibles avec **\`${prefix}help\`**.`
    )
    .setFooter({ text: 'AdsCords • Diffusion de campagnes avec crédits' });
}

export function helpEmbed(prefix: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Centre d’aide • AdsCords')
    .setDescription('Un bot rapide pour diffuser des campagnes seulement dans les salons explicitement configurés.')
    .addFields(
      {
        name: `${prefix}config`,
        value: 'Administrateurs : choisir un salon existant ou créer automatiquement `#ads-cords`.'
      },
      {
        name: `${prefix}mapub`,
        value: 'Uniquement sur le serveur autorisé : affiche l’image complète de vos campagnes et de leur budget journalier.'
      },
      {
        name: `${prefix}mesgains`,
        value: 'Propriétaires de serveurs : affiche les gains cumulés de tous vos serveurs configurés.'
      },
      {
        name: `${prefix}profile`,
        value: 'Affiche votre récapitulatif de compte, sans exposer vos publicités encore en cours.'
      },
      {
        name: `${prefix}bonus`,
        value: 'Affiche votre solde de crédits bonus. Le propriétaire peut consulter celui d’un utilisateur.'
      },
      {
        name: `${prefix}owner`,
        value: 'Propriétaire AdsCords uniquement : affiche les revenus globaux de la plateforme.'
      },
      {
        name: 'Clic sur une publicité',
        value: 'Un premier clic valorisé est appliqué tous les 3 jours, puis les nouveaux clics sont valorisés automatiquement.'
      }
    )
    .setFooter({ text: 'Le bouton ouvre directement le serveur ou l’offre concernée.' });

  return embed;
}

export function configEmbed(prefix: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('Configuration AdsCords')
    .setDescription(
      `Choisissez le salon dans lequel AdsCords publiera les campagnes.\n\n` +
        `Vous pouvez sélectionner un salon existant, ou laisser le bot créer **#ads-cords**.\n` +
        `Seuls les administrateurs peuvent lancer cette commande avec **\`${prefix}config\`**.`
    );
}

export function newAdEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xfaa61a)
    .setTitle('Nouvelle publicité')
    .setDescription(
      'Indiquez le lien, le texte principal, l’ID Discord du propriétaire, la durée et le budget total.\n' +
        'Vous choisirez ensuite le format et une campagne en euros ou en crédits bonus. Le budget est réparti automatiquement par jour.'
    );
}

export function adEmbed(ad: AdCampaign): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xfaa61a)
    .setTitle('📣 Publicité')
    .setDescription(ad.description)
    .setFooter({ text: `${ad.rewardType === 'bonus' ? 'Crédits bonus' : 'Campagne en euros'} • ${ad.durationDays} jour${ad.durationDays > 1 ? 's' : ''}` })
    .setTimestamp(new Date(ad.createdAt));

  if (ad.mediaUrl) embed.setImage(ad.mediaUrl);
  return embed;
}

export function isDiscordServerLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === 'discord.gg' || host === 'www.discord.gg' ||
      ((host === 'discord.com' || host === 'www.discord.com' || host === 'discordapp.com') && parsed.pathname.startsWith('/invite/'));
  } catch {
    return false;
  }
}

export function adRow(trackingUrl: string, destinationUrl: string, disabled = false): ActionRowBuilder<ButtonBuilder> {
  const label = disabled ? 'Campagne terminée' : isDiscordServerLink(destinationUrl) ? 'Rejoindre le serveur' : 'Voir le site';
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(trackingUrl).setLabel(label).setDisabled(disabled)
  );
}

export function destinationRow(url: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(isDiscordServerLink(url) ? 'Rejoindre le serveur' : 'Voir le site').setURL(url)
  );
}

export function dashboardEmbed(campaigns: CampaignDashboardItem[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🗺️ MaPub • Tableau des campagnes')
    .setDescription('Vue publique des dernières campagnes diffusées par AdsCords. Un clic est dédupliqué par navigateur et par campagne.')
    .setTimestamp();

  if (campaigns.length === 0) {
    return embed.addFields({ name: 'Aucune campagne', value: 'Aucune publicité n’a encore été créée.' });
  }

  for (const campaign of campaigns.slice(0, 12)) {
    const status = campaign.isActive ? '🟢 Active' : '⚪ Terminée';
    const name = `${status} • ${campaign.uniqueClicks} clic${campaign.uniqueClicks > 1 ? 's' : ''}`;
    const value = [
      campaign.description.length > 100 ? `${campaign.description.slice(0, 97)}…` : campaign.description,
      `Budget restant : **${formatEuro(campaign.creditsRemainingCents)}** / ${formatEuro(campaign.initialCreditsCents)}`,
      `\`${progressBar(campaign.initialCreditsCents, campaign.creditsRemainingCents)}\``
    ].join('\n');
    embed.addFields({ name, value });
  }

  return embed.setFooter({ text: 'AdsCords • Les valeurs sont actualisées à chaque ouverture de .mapub' });
}

export function clickGuardEmbed(settings: ClickGuardSettings): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('🛡️ Protection des clics')
    .setDescription('Réglages appliqués aux liens publicitaires directs. La fenêtre anti-abus est de 7 jours.')
    .addFields(
      {
        name: 'Tarification',
        value: [
          `Premier clic valorisé, une fois tous les ${settings.firstValueCooldownDays} jours : **${formatEuro(settings.firstDailyClickCents)}**`,
          `Autres nouveaux clics durant cette période : **${formatEuro(settings.repeatClickMinCents)} à ${formatEuro(settings.repeatClickMaxCents)}** (aléatoire)`
        ].join('\n')
      },
      {
        name: 'Détection anti-spam',
        value: [
          `Signalement à partir de **${settings.suspiciousClicksPerDay}** publicités différentes / jour`,
          `Blocage après **${settings.suspiciousDaysRequired}** jour(s) signalé(s) sur 7`,
          `Durée : **${settings.suspensionDays}** jour(s) sans valeur facturée`
        ].join('\n')
      }
    )
    .setFooter({ text: 'Les liens directs ne révèlent pas le débit au membre.' })
    .setTimestamp(new Date(settings.updatedAt));
}

export function clickGuardRow(ownerId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX.clickGuardOpen}${ownerId}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Modifier la protection')
  );
}

const pricingReasonLabel: Record<string, string> = {
  first_3day: '🟢 Premier clic de la période',
  first_3day_flagged: '⚠️ Premier clic + signalé',
  repeat_3day: '🟡 Clic de la période',
  repeat_3day_flagged: '⚠️ Clic de la période + signalé',
  first_daily: 'Historique : premier clic du jour',
  repeat_daily: 'Historique : clic répété',
  suspended: '🔒 Visiteur bloqué (0 €)',
  legacy: 'Historique ancien',
  already_clicked: 'Déjà compté'
};

function compactVisitor(visitorId: string): string {
  const raw = visitorId.replace(/^web:/u, '');
  return raw.length > 10 ? `${raw.slice(0, 10)}…` : raw;
}

export function clickLogsEmbed(logs: ClickLogEntry[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📋 Journal des clics')
    .setDescription('Derniers clics enregistrés. Les visiteurs directs sont pseudonymisés par navigateur.')
    .setTimestamp();

  if (logs.length === 0) {
    return embed.addFields({ name: 'Aucun clic', value: 'Aucun clic n’a encore été enregistré.' });
  }

  for (const log of logs.slice(0, 20)) {
    const timestamp = Math.floor(new Date(log.clickedAt).getTime() / 1000);
    const suspension =
      log.suspendedUntil && new Date(log.suspendedUntil).getTime() > Date.now()
        ? `\n⛔ Bloqué jusqu’à <t:${Math.floor(new Date(log.suspendedUntil).getTime() / 1000)}:R>`
        : '';
    const reason = pricingReasonLabel[log.pricingReason] ?? log.pricingReason;
    embed.addFields({
      name: `Visiteur ${compactVisitor(log.visitorId)} • pub ${log.adId.slice(0, 8)}`,
      value: `${reason}\nValeur : **${formatEuro(log.chargedCents)}** • <t:${timestamp}:R>${suspension}`
    });
  }

  return embed.setFooter({ text: 'Utilisez .click_guard pour modifier les seuils et les montants.' });
}
