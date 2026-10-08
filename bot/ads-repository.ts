import { supabase } from './supabase.js';
import { campaignPeriodAt } from './campaign-period.js';
import type {
  AdCampaign,
  AdDelivery,
  CampaignDashboardItem,
  CampaignRewardType,
  ClickGuardSettings,
  ClickLogEntry,
  ClickResult,
  RefreshableCampaign
} from './domain.js';

function rewardType(row: Record<string, unknown>): CampaignRewardType {
  return row.reward_type === 'bonus' ? 'bonus' : 'cash';
}

function toCampaign(row: Record<string, unknown>): AdCampaign {
  const createdAt = String(row.created_at);
  return {
    id: String(row.id),
    ownerDiscordId: String(row.owner_discord_id),
    destinationUrl: String(row.destination_url),
    description: String(row.description),
    mediaUrl: row.media_url ? String(row.media_url) : null,
    useEmbed: Boolean(row.use_embed),
    rewardType: rewardType(row),
    durationDays: Number(row.duration_days ?? 1),
    startsAt: String(row.starts_at ?? createdAt),
    endsAt: row.ends_at ? String(row.ends_at) : null,
    initialCreditsCents: Number(row.initial_credits_cents),
    creditsRemainingCents: Number(row.credits_remaining_cents),
    clickCostCents: Number(row.click_cost_cents),
    isActive: Boolean(row.is_active),
    createdAt,
    updatedAt: String(row.updated_at)
  };
}

function toDelivery(row: Record<string, unknown>): AdDelivery {
  const deliveredAt = String(row.delivered_at);
  return {
    id: String(row.id),
    adId: String(row.ad_id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    messageId: String(row.message_id),
    deliveredAt,
    // Fallback défensif pendant le déploiement de la migration 011 : jamais une remontée immédiate.
    nextRepublishAt: row.next_republish_at
      ? String(row.next_republish_at)
      : new Date(new Date(deliveredAt).getTime() + 5 * 60 * 60 * 1000).toISOString()
  };
}

export class AdsRepository {
  async create(input: {
    ownerDiscordId: string;
    destinationUrl: string;
    description: string;
    mediaUrl: string | null;
    useEmbed: boolean;
    rewardType: CampaignRewardType;
    durationDays: number;
    creditsCents: number;
    clickCostCents: number;
  }): Promise<AdCampaign> {
    if (input.rewardType === 'bonus') {
      const { data, error } = await supabase.rpc('create_bonus_campaign', {
        p_owner_discord_id: input.ownerDiscordId,
        p_destination_url: input.destinationUrl,
        p_description: input.description,
        p_media_url: input.mediaUrl,
        p_use_embed: input.useEmbed,
        p_duration_days: input.durationDays,
        p_credits_cents: input.creditsCents,
        p_click_cost_cents: input.clickCostCents
      });
      if (error) {
        if (error.message.includes('BONUS_BALANCE_INSUFFICIENT')) {
          throw new Error('BONUS_BALANCE_INSUFFICIENT');
        }
        throw new Error(`Impossible de créer la campagne bonus : ${error.message}`);
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error('La création bonus ne retourne aucune campagne.');
      return toCampaign(row as Record<string, unknown>);
    }

    const startsAt = new Date();
    const endsAt = input.durationDays === 0 ? null : new Date(startsAt.getTime() + input.durationDays * 24 * 60 * 60 * 1000);
    const { data, error } = await supabase
      .from('ads')
      .insert({
        owner_discord_id: input.ownerDiscordId,
        destination_url: input.destinationUrl,
        description: input.description,
        media_url: input.mediaUrl,
        use_embed: input.useEmbed,
        reward_type: 'cash',
        duration_days: input.durationDays,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt?.toISOString() ?? null,
        initial_credits_cents: input.creditsCents,
        credits_remaining_cents: input.creditsCents,
        click_cost_cents: input.clickCostCents,
        is_active: input.creditsCents >= input.clickCostCents
      })
      .select()
      .single();

    if (error) throw new Error(`Impossible de créer la campagne : ${error.message}`);
    return toCampaign(data as Record<string, unknown>);
  }

  async saveDelivery(input: Omit<AdDelivery, 'id' | 'deliveredAt'>): Promise<void> {
    const { error } = await supabase.from('ad_deliveries').upsert(
      {
        ad_id: input.adId,
        guild_id: input.guildId,
        channel_id: input.channelId,
        message_id: input.messageId,
        delivered_at: new Date().toISOString(),
        next_republish_at: input.nextRepublishAt
      },
      { onConflict: 'ad_id,guild_id' }
    );
    if (error) throw new Error(`Impossible de mémoriser la diffusion : ${error.message}`);
  }

  async listAllDeliveries(): Promise<AdDelivery[]> {
    const { data, error } = await supabase.from('ad_deliveries').select();
    if (error) throw new Error(`Impossible de charger les diffusions : ${error.message}`);
    return (data ?? []).map((row) => toDelivery(row as Record<string, unknown>));
  }

  async removeDeliveries(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await supabase.from('ad_deliveries').delete().in('id', ids);
    if (error) throw new Error(`Impossible de supprimer les diffusions : ${error.message}`);
  }

  async deleteAllCampaigns(): Promise<number> {
    // Les clés étrangères suppriment les diffusions et clics associés. Le journal server_earnings est volontairement conservé.
    const { data, error } = await supabase.from('ads').delete().not('id', 'is', null).select('id');
    if (error) throw new Error(`Impossible de supprimer les campagnes : ${error.message}`);
    return data?.length ?? 0;
  }

  async listDeliveries(adId: string): Promise<AdDelivery[]> {
    const { data, error } = await supabase.from('ad_deliveries').select().eq('ad_id', adId);
    if (error) throw new Error(`Impossible de charger les diffusions : ${error.message}`);
    return (data ?? []).map((row) => toDelivery(row as Record<string, unknown>));
  }

  async registerClick(adId: string, userId: string, guildId: string): Promise<ClickResult> {
    const { data, error } = await supabase.rpc('register_ad_click', {
      p_ad_id: adId,
      p_user_id: userId,
      p_guild_id: guildId
    });
    if (error) throw new Error(`Impossible d'enregistrer le clic : ${error.message}`);

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('La base n’a retourné aucun résultat de clic.');
    const result = row as Record<string, unknown>;
    const status = String(result.status);
    if (!['charged', 'already_clicked', 'unavailable', 'not_found'].includes(status)) {
      throw new Error('La base a retourné un statut de clic invalide.');
    }

    return {
      status: status as ClickResult['status'],
      destinationUrl: result.destination_url ? String(result.destination_url) : null,
      chargedCents: Number(result.charged_cents ?? 0),
      creditsRemainingCents:
        result.credits_remaining_cents === null || result.credits_remaining_cents === undefined
          ? null
          : Number(result.credits_remaining_cents),
      isActive: result.is_active === null || result.is_active === undefined ? null : Boolean(result.is_active),
      pricingReason: result.pricing_reason ? String(result.pricing_reason) : null
    };
  }

  async clickGuardSettings(): Promise<ClickGuardSettings> {
    const { data, error } = await supabase.from('click_guard_settings').select().eq('id', true).single();
    if (error) throw new Error(`Impossible de charger la protection des clics : ${error.message}`);
    return this.toClickGuardSettings(data as Record<string, unknown>);
  }

  async saveClickGuardSettings(input: Omit<ClickGuardSettings, 'historyWindowDays' | 'updatedAt'>): Promise<ClickGuardSettings> {
    const { data, error } = await supabase
      .from('click_guard_settings')
      .upsert(
        {
          id: true,
          first_daily_click_cents: input.firstDailyClickCents,
          first_value_cooldown_days: input.firstValueCooldownDays,
          repeat_click_min_cents: input.repeatClickMinCents,
          repeat_click_max_cents: input.repeatClickMaxCents,
          suspicious_clicks_per_day: input.suspiciousClicksPerDay,
          suspicious_days_required: input.suspiciousDaysRequired,
          suspension_days: input.suspensionDays
        },
        { onConflict: 'id' }
      )
      .select()
      .single();
    if (error) throw new Error(`Impossible d'enregistrer la protection des clics : ${error.message}`);
    return this.toClickGuardSettings(data as Record<string, unknown>);
  }

  async recentClickLogs(limit = 12): Promise<ClickLogEntry[]> {
    const { data: clicks, error: clicksError } = await supabase
      .from('ad_clicks')
      .select('ad_id, user_id, guild_id, charged_cents, pricing_reason, clicked_at')
      .order('clicked_at', { ascending: false })
      .limit(limit);
    if (clicksError) throw new Error(`Impossible de charger les journaux de clics : ${clicksError.message}`);

    const visitorIds = [...new Set((clicks ?? []).map((click) => String((click as Record<string, unknown>).user_id)))];
    const suspendedUntilByVisitor = new Map<string, string | null>();
    if (visitorIds.length > 0) {
      const { data: profiles, error: profilesError } = await supabase
        .from('click_profiles')
        .select('visitor_id, suspended_until')
        .in('visitor_id', visitorIds);
      if (profilesError) throw new Error(`Impossible de charger les profils visiteurs : ${profilesError.message}`);
      for (const profile of profiles ?? []) {
        const row = profile as Record<string, unknown>;
        suspendedUntilByVisitor.set(String(row.visitor_id), row.suspended_until ? String(row.suspended_until) : null);
      }
    }

    return (clicks ?? []).map((click) => {
      const row = click as Record<string, unknown>;
      const visitorId = String(row.user_id);
      return {
        visitorId,
        adId: String(row.ad_id),
        guildId: String(row.guild_id),
        chargedCents: Number(row.charged_cents ?? 0),
        pricingReason: String(row.pricing_reason ?? 'legacy'),
        clickedAt: String(row.clicked_at),
        suspendedUntil: suspendedUntilByVisitor.get(visitorId) ?? null
      };
    });
  }

  async dashboard(limit = 12, ownerDiscordId?: string): Promise<CampaignDashboardItem[]> {
    let query = supabase.from('ads').select().order('created_at', { ascending: false }).limit(limit);
    if (ownerDiscordId) query = query.eq('owner_discord_id', ownerDiscordId);
    const { data: ads, error: adsError } = await query;
    if (adsError) throw new Error(`Impossible de charger les campagnes : ${adsError.message}`);

    const campaigns = (ads ?? []).map((row) => toCampaign(row as Record<string, unknown>));
    if (campaigns.length === 0) return [];

    const { data: clicks, error: clicksError } = await supabase
      .from('ad_clicks')
      .select('ad_id')
      .in(
        'ad_id',
        campaigns.map((campaign) => campaign.id)
      );
    if (clicksError) throw new Error(`Impossible de compter les clics : ${clicksError.message}`);

    const countByAd = new Map<string, number>();
    for (const click of clicks ?? []) {
      const adId = String((click as Record<string, unknown>).ad_id);
      countByAd.set(adId, (countByAd.get(adId) ?? 0) + 1);
    }

    const now = Date.now();
    return campaigns.map((campaign) => ({
      ...campaign,
      isActive: campaign.isActive && (!campaign.endsAt || new Date(campaign.endsAt).getTime() > now),
      uniqueClicks: countByAd.get(campaign.id) ?? 0
    }));
  }

  /** Campagnes encore actives dont le plafond du créneau courant de 24 h n'est pas consommé. */
  async refreshableCampaigns(): Promise<RefreshableCampaign[]> {
    const { data, error } = await supabase.from('ads').select().eq('is_active', true);
    if (error) throw new Error(`Impossible de charger les campagnes à republier : ${error.message}`);

    const now = new Date();
    const eligible = (data ?? [])
      .map((row) => toCampaign(row as Record<string, unknown>))
      .filter((campaign) => new Date(campaign.startsAt).getTime() <= now.getTime() && (!campaign.endsAt || new Date(campaign.endsAt).getTime() > now.getTime()));
    if (eligible.length === 0) return [];

    const [{ data: clicks, error: clicksError }, { data: settings, error: settingsError }] = await Promise.all([
      supabase
        .from('ad_clicks')
        .select('ad_id, charged_cents, clicked_at')
        .in('ad_id', eligible.map((campaign) => campaign.id)),
      supabase.from('click_guard_settings').select('repeat_click_min_cents').eq('id', true).single()
    ]);
    if (clicksError) throw new Error(`Impossible de charger les budgets journaliers : ${clicksError.message}`);
    if (settingsError) throw new Error(`Impossible de charger le coût minimal de republication : ${settingsError.message}`);
    const minimumValuableClickCents = Number((settings as Record<string, unknown>).repeat_click_min_cents);

    const clicksByCampaign = new Map<string, Array<{ chargedCents: number; clickedAt: number }>>();
    for (const raw of clicks ?? []) {
      const row = raw as Record<string, unknown>;
      const adId = String(row.ad_id);
      const entries = clicksByCampaign.get(adId) ?? [];
      entries.push({ chargedCents: Number(row.charged_cents ?? 0), clickedAt: new Date(String(row.clicked_at)).getTime() });
      clicksByCampaign.set(adId, entries);
    }

    return eligible.flatMap((campaign) => {
      // Sans durée, le budget total est disponible jusqu'à son épuisement : aucun plafond de 24 h ne s'applique.
      if (campaign.durationDays === 0) {
        if (campaign.creditsRemainingCents < minimumValuableClickCents) return [];
        return [{ ...campaign, dailyBudgetCents: campaign.creditsRemainingCents, spentTodayCents: 0 }];
      }

      const period = campaignPeriodAt(campaign.startsAt, campaign.durationDays, campaign.initialCreditsCents, now.getTime());
      if (!period) return [];
      const spentTodayCents = (clicksByCampaign.get(campaign.id) ?? [])
        .filter((click) => click.clickedAt >= period.startsAtMs && click.clickedAt < period.endsAtMs)
        .reduce((total, click) => total + click.chargedCents, 0);
      const availableTodayCents = period.budgetCents - spentTodayCents;
      if (availableTodayCents < minimumValuableClickCents || campaign.creditsRemainingCents < minimumValuableClickCents) return [];
      return [{ ...campaign, dailyBudgetCents: period.budgetCents, spentTodayCents }];
    });
  }

  /** Retourne une seule fois les campagnes dont les messages/URLs doivent être retirés. */
  async campaignsNeedingDeliveryCleanup(): Promise<string[]> {
    const now = new Date().toISOString();
    const { error: expireError } = await supabase
      .from('ads')
      .update({ is_active: false })
      .eq('is_active', true)
      .lte('ends_at', now);
    if (expireError) throw new Error(`Impossible d’expirer les campagnes terminées : ${expireError.message}`);

    const { data, error } = await supabase
      .from('ads')
      .select('id, is_active, ends_at')
      .is('delivery_cleaned_at', null);
    if (error) throw new Error(`Impossible de rechercher les campagnes à nettoyer : ${error.message}`);
    return (data ?? [])
      .filter((row) => {
        const campaign = row as Record<string, unknown>;
        return !Boolean(campaign.is_active) || (campaign.ends_at !== null && new Date(String(campaign.ends_at)).getTime() <= Date.now());
      })
      .map((row) => String((row as Record<string, unknown>).id));
  }

  async markCampaignDeliveriesCleaned(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await supabase
      .from('ads')
      .update({ delivery_cleaned_at: new Date().toISOString() })
      .in('id', ids);
    if (error) throw new Error(`Impossible de marquer le nettoyage des campagnes : ${error.message}`);
  }

  async campaignsForProfile(ownerDiscordId: string): Promise<CampaignDashboardItem[]> {
    const { data: ads, error: adsError } = await supabase
      .from('ads')
      .select()
      .eq('owner_discord_id', ownerDiscordId)
      .order('created_at', { ascending: false });
    if (adsError) throw new Error(`Impossible de charger le profil des campagnes : ${adsError.message}`);

    const campaigns = (ads ?? []).map((row) => toCampaign(row as Record<string, unknown>));
    if (campaigns.length === 0) return [];
    const { data: clicks, error: clicksError } = await supabase
      .from('ad_clicks')
      .select('ad_id')
      .in('ad_id', campaigns.map((campaign) => campaign.id));
    if (clicksError) throw new Error(`Impossible de charger les clics du profil : ${clicksError.message}`);

    const countByAd = new Map<string, number>();
    for (const click of clicks ?? []) {
      const adId = String((click as Record<string, unknown>).ad_id);
      countByAd.set(adId, (countByAd.get(adId) ?? 0) + 1);
    }
    return campaigns.map((campaign) => ({ ...campaign, uniqueClicks: countByAd.get(campaign.id) ?? 0 }));
  }

  private toClickGuardSettings(row: Record<string, unknown>): ClickGuardSettings {
    return {
      firstDailyClickCents: Number(row.first_daily_click_cents),
      firstValueCooldownDays: Number(row.first_value_cooldown_days ?? 3),
      repeatClickMinCents: Number(row.repeat_click_min_cents),
      repeatClickMaxCents: Number(row.repeat_click_max_cents),
      suspiciousClicksPerDay: Number(row.suspicious_clicks_per_day),
      suspiciousDaysRequired: Number(row.suspicious_days_required),
      historyWindowDays: Number(row.history_window_days),
      suspensionDays: Number(row.suspension_days),
      updatedAt: String(row.updated_at)
    };
  }
}
