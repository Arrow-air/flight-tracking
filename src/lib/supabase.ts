import { createClient } from '@supabase/supabase-js';
import { markRecovery } from './oauthCallback';
import { bridgeStorage, frameHub, hubOrigin } from './sessionBridge';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must be set');
}

/** Exported for direct storage endpoints (resumable uploads in logs.ts). */
export const supabaseUrl: string = url.replace(/\/+$/, '');
export const supabaseKey: string = key;

// Sign in once across Arrow apps: the session lives with app.arrowair.com's
// (sessionBridge.ts). Elsewhere, and if the bridge doesn't answer, this app's
// own storage.
const hubAt =
  typeof window === 'undefined'
    ? null
    : hubOrigin(import.meta.env.VITE_SESSION_HUB, window.location.hostname);
const bridge = hubAt ? frameHub(hubAt) : null;

/** Runs when someone signs in or out in another Arrow app's tab. */
export function onSharedSignInChange(fn: () => void): void {
  bridge?.onChange(fn);
}

// PKCE: a link back from GitHub or an email only signs in the browser that
// asked for it, so nobody can send a link that signs someone into another
// account (which the superapp and the forum would then share).
export const supabase = createClient(url, key, {
  auth: {
    flowType: 'pkce',
    ...(bridge ? { storage: bridgeStorage(bridge.hub, window.localStorage) } : {}),
  },
});

// A reset link signed them in: Login asks for a new password. supabase-js
// reports it while reading the link, before anything else listens.
supabase.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') markRecovery();
});
