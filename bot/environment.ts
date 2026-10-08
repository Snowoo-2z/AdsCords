import 'dotenv/config';

import {
  DEFAULT_AUTO_CHANNEL_NAME,
  DEFAULT_BOT_OWNER_ID,
  DEFAULT_CLICK_COST_CENTS,
  DEFAULT_MAPUB_GUILD_ID,
  DEFAULT_PREFIX
} from './constants.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} doit être un entier strictement positif.`);
  }
  return parsed;
}

const supabaseUrl = required('SUPABASE_URL');
const trackingBaseUrl = process.env.AD_TRACKING_URL?.trim() || `${supabaseUrl.replace(/\/$/u, '')}/functions/v1/visit`;

const prefix = process.env.COMMAND_PREFIX?.trim() || DEFAULT_PREFIX;
if (prefix.length > 3 || /\s/.test(prefix)) {
  throw new Error('COMMAND_PREFIX doit contenir de 1 à 3 caractères sans espace.');
}

export const env = {
  discordToken: required('DISCORD_TOKEN'),
  supabaseUrl,
  trackingBaseUrl,
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  botOwnerId: process.env.BOT_OWNER_ID?.trim() || DEFAULT_BOT_OWNER_ID,
  mapubGuildId: process.env.MAPUB_GUILD_ID?.trim() || DEFAULT_MAPUB_GUILD_ID,
  commandPrefix: prefix,
  clickCostCents: positiveInteger(process.env.CLICK_COST_CENTS, DEFAULT_CLICK_COST_CENTS, 'CLICK_COST_CENTS'),
  autoChannelName: (process.env.AUTO_CHANNEL_NAME?.trim() || DEFAULT_AUTO_CHANNEL_NAME).toLowerCase()
} as const;
