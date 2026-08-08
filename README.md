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

## Database

Schema migrations live in `supabase/migrations/` and are applied to the self-hosted
Supabase. Studio is available at https://supabase.arrowair.com (credentials with the team).

## Deployment

Openship project `flight-tracking` (Arrow org) builds `main` on push and serves it at
https://flights.arrowair.com. Build-time env (`VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY`) is set in the Openship project — no secrets in this repo.
