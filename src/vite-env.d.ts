/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  /** 'true' enables the GitHub OAuth button (prod GoTrue has the provider). */
  readonly VITE_GITHUB_AUTH_ENABLED?: string;
}
