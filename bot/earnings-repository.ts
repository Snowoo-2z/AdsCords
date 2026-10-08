import { supabase } from './supabase.js';
import type { EarningsSummary, GuildEarnings, OwnerEarningsSummary } from './domain.js';

interface EarningsRow {
  guild_id: unknown;
  reward_type: unknown;
  server_share_milli_cents: unknown;
  platform_share_milli_cents: unknown;
}

function emptySummary(): EarningsSummary {
  return { cashMilliCents: 0, bonusMilliCents: 0, paidClicks: 0, guilds: [] };
}

export class EarningsRepository {
  async forOwner(ownerDiscordId: string): Promise<EarningsSummary> {
    const { data, error } = await supabase
      .from('server_earnings')
      .select('guild_id, reward_type, server_share_milli_cents, platform_share_milli_cents')
      .eq('owner_discord_id', ownerDiscordId);
    if (error) throw new Error(`Impossible de charger les gains des serveurs : ${error.message}`);

    const summary = emptySummary();
    const byGuild = new Map<string, GuildEarnings>();
    for (const raw of data ?? []) {
      const row = raw as EarningsRow;
      const guildId = String(row.guild_id);
      let guild = byGuild.get(guildId);
      if (!guild) {
        guild = { guildId, cashMilliCents: 0, bonusMilliCents: 0, paidClicks: 0 };
        byGuild.set(guildId, guild);
      }
      const amount = Number(row.server_share_milli_cents ?? 0);
      guild.paidClicks += 1;
      summary.paidClicks += 1;
      if (row.reward_type === 'bonus') {
        guild.bonusMilliCents += amount;
        summary.bonusMilliCents += amount;
      } else {
        guild.cashMilliCents += amount;
        summary.cashMilliCents += amount;
      }
    }
    summary.guilds = [...byGuild.values()].sort(
      (left, right) => right.cashMilliCents + right.bonusMilliCents - (left.cashMilliCents + left.bonusMilliCents)
    );
    return summary;
  }

  async ownerSummary(): Promise<OwnerEarningsSummary> {
    const { data, error } = await supabase
      .from('server_earnings')
      .select('reward_type, server_share_milli_cents, platform_share_milli_cents');
    if (error) throw new Error(`Impossible de charger les gains AdsCords : ${error.message}`);

    return (data ?? []).reduce<OwnerEarningsSummary>(
      (summary, raw) => {
        const row = raw as EarningsRow;
        summary.paidClicks += 1;
        if (row.reward_type === 'bonus') {
          summary.serverBonusMilliCents += Number(row.server_share_milli_cents ?? 0);
        } else {
          summary.serverCashMilliCents += Number(row.server_share_milli_cents ?? 0);
          summary.platformCashMilliCents += Number(row.platform_share_milli_cents ?? 0);
        }
        return summary;
      },
      { platformCashMilliCents: 0, serverCashMilliCents: 0, serverBonusMilliCents: 0, paidClicks: 0 }
    );
  }
}
