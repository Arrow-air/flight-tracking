/**
 * Auth store (module singleton): GoTrue session + user_profiles row + the
 * operator control edge (aircraft_operators for the current user), driving
 * all role-aware UI decisions.
 *
 * Email auth is live. GitHub OAuth is wired behind VITE_GITHUB_AUTH_ENABLED —
 * the OAuth app's callback targets prod GoTrue, so the button only shows where
 * the flag is on (see .env.example).
 */
import type { Session } from '@supabase/supabase-js';
import { computed, reactive } from 'vue';
import type { Profile } from './db';
// Imported for its module side effect: captures a failed-OAuth callback
// error from the URL at bootstrap, before router/supabase-js rewrite it.
// Login.vue reads it via consumeOAuthCallbackError().
import './oauthCallback';
import { supabase } from './supabase';

export const githubEnabled =
  (import.meta.env.VITE_GITHUB_AUTH_ENABLED ?? '').toLowerCase() === 'true';

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  /** aircraft ids the current user is an assigned operator of */
  operatorOf: string[];
  ready: boolean;
}

export const auth = reactive<AuthState>({
  session: null,
  profile: null,
  operatorOf: [],
  ready: false,
});

export const userId = computed(() => auth.session?.user.id ?? null);
export const userEmail = computed(() => auth.session?.user.email ?? null);
export const roles = computed(() => auth.profile?.roles ?? []);
export const isAdmin = computed(() => roles.value.includes('admin'));
export const isManufacturer = computed(() =>
  roles.value.includes('manufacturer'),
);

/** admin everywhere; operators only on aircraft they are assigned to.
 *  Mirrors app.can_write_aircraft_data() so the UI hides what RLS denies. */
export function canWriteAircraft(aircraftId: string): boolean {
  return isAdmin.value || auth.operatorOf.includes(aircraftId);
}

/** component_events additionally allow manufacturers (build workflow). */
export function canWriteComponents(aircraftId: string): boolean {
  return canWriteAircraft(aircraftId) || isManufacturer.value;
}

/** Client-side mirror of app.can_view_raw_gps (server enforces; UI hides). */
export function canViewRawGps(flight: {
  gps_private: boolean;
  created_by: string;
  pilot_id: string | null;
}): boolean {
  if (isAdmin.value) return true;
  if (!flight.gps_private) return true;
  const uid = userId.value;
  return uid != null && (flight.created_by === uid || flight.pilot_id === uid);
}

async function loadProfile(): Promise<void> {
  const uid = auth.session?.user.id;
  if (!uid) {
    auth.profile = null;
    auth.operatorOf = [];
    return;
  }
  const [profileRes, opsRes] = await Promise.all([
    supabase.from('user_profiles').select('*').eq('id', uid).maybeSingle(),
    supabase.from('aircraft_operators').select('aircraft_id').eq('user_id', uid),
  ]);
  auth.profile = (profileRes.data as Profile | null) ?? null;
  auth.operatorOf = (opsRes.data ?? []).map(
    (r: { aircraft_id: string }) => r.aircraft_id,
  );
}

let initPromise: Promise<void> | null = null;

/** Idempotent; router guard awaits this before deciding anything. */
export function initAuth(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const { data } = await supabase.auth.getSession();
      auth.session = data.session;
      if (auth.session) await loadProfile();
      auth.ready = true;
      supabase.auth.onAuthStateChange((_event, session) => {
        const changed = session?.user.id !== auth.session?.user.id;
        auth.session = session;
        if (!session) {
          auth.profile = null;
          auth.operatorOf = [];
        } else if (changed || !auth.profile) {
          void loadProfile();
        }
      });
    })();
  }
  return initPromise;
}

/** Re-fetch profile + operator assignments (e.g. after admin edits). */
export function refreshProfile(): Promise<void> {
  return loadProfile();
}

export async function signInWithEmail(
  email: string,
  password: string,
): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

export async function signUpWithEmail(
  email: string,
  password: string,
  name: string,
): Promise<{ needsConfirmation: boolean }> {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });
  if (error) throw new Error(error.message);
  return { needsConfirmation: !data.session };
}

export async function signInWithGitHub(): Promise<void> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: window.location.origin },
  });
  if (error) throw new Error(error.message);
}

export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/login`,
  });
  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}
