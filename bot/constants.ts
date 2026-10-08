/** Identifiants fournis pour l'instance AdsCords. Ils restent surchargeables par .env. */
export const DEFAULT_BOT_OWNER_ID = '1554498783172235345';
export const DEFAULT_MAPUB_GUILD_ID = '1556728584285196408';
export const DEFAULT_PREFIX = '.';
export const DEFAULT_CLICK_COST_CENTS = 10;
export const DEFAULT_AUTO_CHANNEL_NAME = 'ads-cords';

export const COMPONENT_PREFIX = {
  configPick: 'cfg:pick:',
  configCreate: 'cfg:create:',
  configSelect: 'cfg:select:',
  adPanel: 'pub:open:',
  adModal: 'pub:modal',
  adSkipMedia: 'pub:skip-media:',
  adOptions: 'pub:options:',
  clickGuardOpen: 'guard:open:',
  clickGuardModal: 'guard:modal',
  clearPubsConfirm: 'pub:clear-confirm:'
} as const;
