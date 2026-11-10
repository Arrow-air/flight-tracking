# Arrow Flight Tracking

Flight tracking platform for Arrow aircraft — ground-up rebuild designed to run on
Arrow's own infrastructure ([Openship](https://ship.arrowair.com) + self-hosted Supabase).

Succeeds [`project-flight-tracking`](https://github.com/Arrow-air/project-flight-tracking),
which remains the reference for the previous schema and holds the legacy data until import.

## Stack

- **Frontend:** Vue 3 + Vite + TypeScript (SPA)
- **Backend:** self-hosted Supabase at `supabase.arrowair.com` — Postgres 17, GoTrue auth,
  PostgREST, Realtime, Storage
- **Log parsing:** DataFlash/MAVLink parsing will live in a standalone service (not an edge
  function) — TBD during rebuild
- **Hosting/CD:** Openship on Arrow Prod; every push to `main` auto-deploys

## Development

```sh
cp .env.example .env   # fill in the anon key
npm install
npm run dev
```

`npm run build` produces a static bundle in `dist/`. `npm run typecheck` runs vue-tsc.

## Authentication

Email/password auth (GoTrue) is always on. **GitHub OAuth** is feature-flagged in the
frontend: the "Continue with GitHub" button on `/login` renders only when the build has
`VITE_GITHUB_AUTH_ENABLED=true`. Enable the flag only for builds that target a GoTrue
instance with the GitHub provider configured (see below) — with the flag off, nothing
GitHub-related ships in the UI.

### GoTrue server env (set on the auth container, NOT read by Vite)

| Variable | Value |
| --- | --- |
| `GOTRUE_EXTERNAL_GITHUB_ENABLED` | `true` |
| `GOTRUE_EXTERNAL_GITHUB_CLIENT_ID` | `Ov23liqSDMPkyBhht5hG` (the Arrow OAuth app) |
| `GOTRUE_EXTERNAL_GITHUB_SECRET` | from the secrets store — **never commit** |
| `GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI` | `https://supabase.arrowair.com/auth/v1/callback` |

The GitHub OAuth app's authorization callback URL must match
`GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI` exactly. After GoTrue completes the exchange it
redirects the browser back to the app origin (`signInWithOAuth` passes
`redirectTo: window.location.origin`), so `GOTRUE_SITE_URL` /
`GOTRUE_URI_ALLOW_LIST` must include `https://flights.arrowair.com` or GoTrue will
fall back to its configured site URL.

### Flow and provisioning

- `src/lib/auth.ts` `signInWithGitHub()` → `supabase.auth.signInWithOAuth({ provider:
  'github' })` → GitHub → GoTrue callback → redirect to the app origin with tokens in
  the URL hash. supabase-js (`detectSessionInUrl`) consumes them before the router
  guard's `initAuth()` resolves — no dedicated callback route is needed.
- A failed callback (user denies the prompt, provider error) comes back with
  `error`/`error_description` params instead; `src/lib/oauthCallback.ts` captures and
  strips them at bootstrap and `/login` shows the message.
- First login provisioning: the `on_auth_user_created` trigger
  (`supabase/migrations/20260810210200_helpers.sql`) inserts a `user_profiles` row for
  every new `auth.users` row — email or OAuth — with `roles` defaulting to
  `{operator}` and no aircraft assignments. GitHub metadata is used for the display
  name (`full_name`, then `user_name`, then the email local-part). No extra migration
  is needed for OAuth users.

### Sign in once across Arrow apps

- The session lives in app.arrowair.com's storage: `src/lib/supabase.ts` gives
  supabase-js the storage from `src/lib/sessionBridge.ts`, which reaches
  `https://app.arrowair.com/session-bridge.html` in a hidden frame. That page answers
  only https://flights.arrowair.com, so signing in or out here or on the superapp does
  both, and nothing is shared with the rest of arrowair.com (the forum and the website
  are hosted elsewhere). A copy stays here, marked `<key>-shared`, and answers while the
  bridge doesn't (no answer within 4 s; it's tried again after 30 s), so a slow or
  missing app.arrowair.com doesn't sign anyone out.
- This app keeps its own sign-in, as before the bridge, when the frame can't see
  app.arrowair.com's storage: Safari and every iPhone browser give a frame under another
  address storage of its own, gone when the browser closes, and a browser that never
  opened app.arrowair.com has nothing to share yet. The bridge tells which (`shared` in
  its hello): app.arrowair.com marks its storage whenever it opens as a page of its own.
  So sign-in once works in Chrome, Edge and Firefox, not in Safari or on iPhones.
- A sign-in this app kept itself (from before the bridge, or made while the bridge didn't
  answer) moves to the bridge when it next answers, unless app.arrowair.com has a newer
  one of the same account. If app.arrowair.com holds another account, this app keeps its
  own until someone signs out here.
- Signing in or out in a superapp tab reloads an open flights tab when the account
  changes (`initAuth` in `src/lib/auth.ts`).
- Deploy app.arrowair.com first: until it has `session-bridge.html`, the frame gets the
  superapp's own page instead, and every first load here waits 4 s for an answer.
- Sign-in links use PKCE (`flowType: 'pkce'`): a link back from GitHub or an email signs
  in only the browser that asked for it, so nobody can send a link that signs someone into
  another account. A confirmation link opened in another browser still confirms the
  address; they then sign in with their password. A reset link brings them to `/login`,
  which asks for the new password when supabase-js reports `PASSWORD_RECOVERY`.
- `VITE_SESSION_HUB` picks another bridge origin (local tests); empty turns it off.
  Unset, the bridge is used only on flights.arrowair.com, so local dev keeps its own
  sign-in.

### Manual test plan (requires the provider secret; cannot be run locally)

1. Set the four `GOTRUE_EXTERNAL_GITHUB_*` vars on the GoTrue container and restart it.
2. Deploy/serve a build with `VITE_GITHUB_AUTH_ENABLED=true`.
3. `/login` → "Continue with GitHub" → authorize on GitHub → you land back on the app
   signed in (fleet page, no `#access_token` left in the URL).
4. With a GitHub account that has never signed in: after step 3, the sidebar shows
   role `operator`, `/flights/new` shows no assignable aircraft, and
   `user_profiles` has a new row (name from GitHub, `roles = {operator}`) with zero
   `aircraft_operators` rows — identical to a fresh email signup.
5. Repeat but click **Cancel** on the GitHub authorize screen: you land on `/login`
   with a "GitHub sign-in failed: …" banner and a clean URL.
6. Sign out; confirm you return to `/login` and the button still works for an
   already-provisioned GitHub user (no duplicate profile row).

## Database

Schema migrations live in `supabase/migrations/` and are applied to the self-hosted
Supabase. Studio is available at https://supabase.arrowair.com (credentials with the team).

## Deployment

Openship project `flight-tracking` (Arrow org) builds `main` on push and serves it at
https://flights.arrowair.com. Build-time env (`VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY`) is set in the Openship project — no secrets in this repo.
