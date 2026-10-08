import { supabase } from './supabase.js';
import type { GuildSettings } from './domain.js';

function toSettings(row: Record<string, unknown>): GuildSettings {
  return {
    guildId: String(row.guild_id),
    adChannelId: String(row.ad_channel_id),
    ownerDiscordId: row.owner_discord_id ? String(row.owner_discord_id) : null,
    updatedAt: String(row.updated_at)
  };
}

export class SettingsRepository {
  async save(guildId: string, adChannelId: string, ownerDiscordId: string): Promise<GuildSettings> {
    const { data, error } = await supabase
      .from('guild_settings')
      .upsert(
        {
          guild_id: guildId,
          ad_channel_id: adChannelId,
          owner_discord_id: ownerDiscordId,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'guild_id' }
      )
      .select()
      .single();

    if (error) throw new Error(`Impossible d'enregistrer la configuration : ${error.message}`);
    return toSettings(data as Record<string, unknown>);
  }

  async syncOwner(guildId: string, ownerDiscordId: string): Promise<void> {
    const { error } = await supabase
      .from('guild_settings')
      .update({ owner_discord_id: ownerDiscordId, updated_at: new Date().toISOString() })
      .eq('guild_id', guildId);
    if (error) throw new Error(`Impossible de synchroniser le propriétaire du serveur : ${error.message}`);
  }

  async list(): Promise<GuildSettings[]> {
    const { data, error } = await supabase.from('guild_settings').select().order('updated_at', { ascending: false });
    if (error) throw new Error(`Impossible de charger les configurations : ${error.message}`);
    return (data ?? []).map((row) => toSettings(row as Record<string, unknown>));
  }
}
