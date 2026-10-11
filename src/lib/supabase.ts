import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must be set');
}

/** Exported for direct storage endpoints (resumable uploads in logs.ts). */
export const supabaseUrl: string = url.replace(/\/+$/, '');
export const supabaseKey: string = key;

export const supabase = createClient(url, key);
