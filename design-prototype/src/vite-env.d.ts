/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_SITE_URL: string
  readonly VITE_GA_MEASUREMENT_ID: string
  readonly VITE_ENABLE_ANALYTICS: string
  readonly VITE_ENABLED_OAUTH_PROVIDERS: string
  readonly VITE_TIMEZONE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
