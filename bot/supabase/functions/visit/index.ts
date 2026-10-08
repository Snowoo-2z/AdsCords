import { createClient } from 'npm:@supabase/supabase-js@2';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DISCORD_SNOWFLAKE = /^\d{15,25}$/u;
const VISITOR_COOKIE = 'adscords_visitor';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY est absent des secrets Edge Function.');
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(';')) {
    const [key, ...parts] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(parts.join('='));
  }
  return null;
}

function page(status: number, title: string, text: string): Response {
  return new Response(
    `<!doctype html><html lang="fr"><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1><p>${text}</p></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

Deno.serve(async (request) => {
  if (request.method !== 'GET') {
    return page(405, 'Méthode non autorisée', 'Utilisez le lien de la publicité.');
  }

  const url = new URL(request.url);
  const adId = url.searchParams.get('ad') ?? '';
  const guildId = url.searchParams.get('guild') ?? '';
  if (!UUID.test(adId) || !DISCORD_SNOWFLAKE.test(guildId)) {
    return page(400, 'Lien invalide', 'Cette publicité ne peut pas être ouverte.');
  }

  // Le lien ne doit être utilisable que depuis un message effectivement publié par AdsCords.
  const { data: delivery, error: deliveryError } = await supabase
    .from('ad_deliveries')
    .select('ad_id')
    .eq('ad_id', adId)
    .eq('guild_id', guildId)
    .maybeSingle();
  if (deliveryError || !delivery) {
    return page(404, 'Publicité introuvable', 'Cette publicité n’est plus disponible.');
  }

  const storedVisitor = cookieValue(request.headers.get('cookie'), VISITOR_COOKIE);
  const visitorId = storedVisitor && UUID.test(storedVisitor) ? storedVisitor : crypto.randomUUID();
  const { data, error } = await supabase.rpc('register_ad_click', {
    p_ad_id: adId,
    // Un lien Discord ne fournit pas l'identité Discord. Le cookie déduplique le même navigateur.
    p_user_id: `web:${visitorId}`,
    p_guild_id: guildId
  });
  if (error) {
    const diagnosticId = crypto.randomUUID();
    // Les détails restent dans les logs Supabase, jamais dans la page publique de redirection.
    console.error(JSON.stringify({
      event: 'register_ad_click_failed',
      diagnostic_id: diagnosticId,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint
    }));
    return page(500, 'Erreur temporaire', `Reessayez dans quelques instants. Code de diagnostic : ${diagnosticId}`);
  }

  const result = Array.isArray(data) ? data[0] : data;
  if (!result || !['charged', 'already_clicked'].includes(String(result.status)) || !result.destination_url) {
    if (String(result?.pricing_reason) === 'daily_budget_exhausted') {
      return page(429, 'Budget du jour atteint', 'Cette campagne reprendra automatiquement lors de sa prochaine journée de diffusion.');
    }
    return page(410, 'Campagne terminée', 'Cette publicité n’est plus disponible.');
  }

  const headers = new Headers({
    location: String(result.destination_url),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer'
  });
  if (!storedVisitor || !UUID.test(storedVisitor)) {
    headers.append('set-cookie', `${VISITOR_COOKIE}=${visitorId}; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax`);
  }

  // Un seul clic : enregistrement atomique du clic, puis redirection HTTP vers l'invitation / l'offre.
  return new Response(null, { status: 302, headers });
});
