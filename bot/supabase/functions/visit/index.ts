import { createClient } from 'npm:@supabase/supabase-js@2';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DISCORD_SNOWFLAKE = /^\d{15,25}$/u;
const VISITOR_COOKIE = 'adscords_visitor';
const textEncoder = new TextEncoder();

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const visitorCookieSecret = Deno.env.get('VISITOR_COOKIE_SECRET');
if (!supabaseUrl || !serviceRoleKey || !visitorCookieSecret) {
  throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ou VISITOR_COOKIE_SECRET est absent des secrets Edge Function.');
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const visitorSigningKey = crypto.subtle.importKey(
  'raw',
  textEncoder.encode(visitorCookieSecret),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign', 'verify']
);

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(';')) {
    const [key, ...parts] = cookie.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(parts.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function base64UrlBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const padded = value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function signedVisitorCookie(visitorId: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await visitorSigningKey, textEncoder.encode(visitorId));
  return `${visitorId}.${base64Url(new Uint8Array(signature))}`;
}

async function verifiedVisitorId(cookie: string | null): Promise<string | null> {
  if (!cookie) return null;
  const separator = cookie.lastIndexOf('.');
  if (separator <= 0) return null;
  const visitorId = cookie.slice(0, separator);
  const signature = base64UrlBytes(cookie.slice(separator + 1));
  if (!UUID.test(visitorId) || !signature) return null;
  const valid = await crypto.subtle.verify('HMAC', await visitorSigningKey, signature, textEncoder.encode(visitorId));
  return valid ? visitorId : null;
}

function visitorCookie(value: string): string {
  return `${VISITOR_COOKIE}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax`;
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
  const deliveryToken = url.searchParams.get('t') ?? '';
  if (!UUID.test(adId) || !DISCORD_SNOWFLAKE.test(guildId) || !UUID.test(deliveryToken)) {
    return page(400, 'Lien invalide', 'Cette publicité ne peut pas être ouverte.');
  }

  // Le lien doit appartenir au message Discord actuellement diffusé par AdsCords.
  const { data: delivery, error: deliveryError } = await supabase
    .from('ad_deliveries')
    .select('ad_id')
    .eq('ad_id', adId)
    .eq('guild_id', guildId)
    .eq('delivery_token', deliveryToken)
    .maybeSingle();
  if (deliveryError || !delivery) {
    return page(404, 'Publicité introuvable', 'Cette publicité n’est plus disponible.');
  }

  // Le premier passage pose un cookie signé, puis le navigateur reprend automatiquement le même lien.
  // Aucun clic n'est comptabilisé tant que le navigateur ne renvoie pas ce cookie HttpOnly valide.
  const visitorId = await verifiedVisitorId(cookieValue(request.headers.get('cookie'), VISITOR_COOKIE));
  if (!visitorId) {
    const generatedVisitorId = crypto.randomUUID();
    const headers = new Headers({ location: url.toString(), 'cache-control': 'no-store' });
    headers.append('set-cookie', visitorCookie(await signedVisitorCookie(generatedVisitorId)));
    return new Response(null, { status: 302, headers });
  }

  const { data, error } = await supabase.rpc('register_ad_click', {
    p_ad_id: adId,
    // Un lien Discord ne fournit pas l'identité Discord. Le cookie signé déduplique le même navigateur.
    p_user_id: `web:${visitorId}`,
    p_guild_id: guildId,
    p_delivery_token: deliveryToken
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

  // Un seul clic comptabilisé : contrôle atomique, puis redirection HTTP directe vers l'offre.
  return new Response(null, { status: 302, headers });
});
