import { createClient } from '@supabase/supabase-js';

import { env } from './environment.js';

/**
 * Cette clé contourne les RLS : le client Supabase est exclusivement utilisé par le processus Node.
 * Elle ne doit jamais être exposée au navigateur, à Discord ou dans un dépôt Git.
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
});
