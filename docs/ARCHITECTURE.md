# Architecture

## Now (scaffold)
- Vue 3 SPA served static via Openship edge
- Supabase (self-hosted, Arrow Prod box) for auth, Postgres, storage, realtime

## Planned
- `flight_logs` storage bucket for DataFlash uploads
- Standalone parser service (container on Openship) replacing the old Deno edge function
- Data import from legacy hosted Supabase once the new schema stabilizes
