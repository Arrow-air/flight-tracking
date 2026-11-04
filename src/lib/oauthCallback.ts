/**
 * OAuth callback URL handling (A1: GitHub sign-in).
 *
 * SUCCESS path needs no code here: GoTrue redirects back to the app origin
 * with tokens in the URL hash, and supabase-js (`detectSessionInUrl`, on by
 * default) consumes them before `getSession()` resolves — so `initAuth()` in
 * the router guard already sees the session and lets the user through.
 *
 * FAILURE path (user denies the GitHub prompt, provider misconfig, GoTrue
 * error): GoTrue redirects back with `error` / `error_description` params
 * instead of tokens. supabase-js does not surface those to the app, and the
 * router guard would silently bounce to /login. This module captures the
 * error at app bootstrap (import it before the first navigation — auth.ts
 * does), strips it from the URL, and hands it to the login page one time.
 */

/**
 * Pure parser: human-readable error from an OAuth callback URL, or null.
 * Checks the hash first (implicit flow), then the query string (PKCE flow).
 * URLSearchParams already decodes both %xx escapes and '+' as space.
 */
export function extractOAuthError(loc: {
  hash: string;
  search: string;
}): string | null {
  for (const part of [
    loc.hash.replace(/^#/, ''),
    loc.search.replace(/^\?/, ''),
  ]) {
    const params = new URLSearchParams(part);
    const code = params.get('error');
    if (code) return params.get('error_description') || code;
  }
  return null;
}

/**
 * Pure parser: true when the URL is the landing of a password-reset email
 * link. GoTrue puts `type=recovery` beside the tokens in the hash.
 */
export function isRecoveryLanding(loc: { hash: string }): boolean {
  return new URLSearchParams(loc.hash.replace(/^#/, '')).get('type') === 'recovery';
}

let stashed: string | null = null;
let recovery = false;

// Module-eval side effect: runs once at app bootstrap, before supabase-js's
// async URL detection or any router navigation can rewrite the URL.
if (typeof window !== 'undefined') {
  stashed = extractOAuthError(window.location);
  recovery = isRecoveryLanding(window.location);
  if (stashed !== null) {
    // Strip the error params so a reload doesn't re-show a stale error.
    window.history.replaceState(null, '', window.location.pathname);
  }
}

/** A reset link signed this visitor in: they still have to choose a password. */
export function recoveryPending(): boolean {
  return recovery;
}

export function finishRecovery(): void {
  recovery = false;
}

/** One-shot read of the error captured at page load (cleared after read). */
export function consumeOAuthCallbackError(): string | null {
  const error = stashed;
  stashed = null;
  return error;
}
