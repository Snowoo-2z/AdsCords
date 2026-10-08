import { supabase } from './supabase.js';

export class BonusRepository {
  async balance(userDiscordId: string): Promise<number> {
    const { data, error } = await supabase
      .from('bonus_wallets')
      .select('balance_milli_cents')
      .eq('user_discord_id', userDiscordId)
      .maybeSingle();
    if (error) throw new Error(`Impossible de charger le solde bonus : ${error.message}`);
    return data ? Number((data as Record<string, unknown>).balance_milli_cents ?? 0) : 0;
  }

  async credit(userDiscordId: string, amountMilliCents: number): Promise<number> {
    const { data, error } = await supabase.rpc('credit_bonus_wallet', {
      p_user_discord_id: userDiscordId,
      p_amount_milli_cents: amountMilliCents,
      p_reason: 'manual_credit'
    });
    if (error) throw new Error(`Impossible d’ajouter les crédits bonus : ${error.message}`);
    return Number(data ?? 0);
  }
}
