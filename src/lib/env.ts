const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? ''
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

if (import.meta.env.PROD && (!supabaseUrl || !supabaseAnonKey)) {
  console.error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill them in.',
  )
}

export const env = {
  supabaseUrl,
  supabaseAnonKey,
  siteUrl: import.meta.env.VITE_SITE_URL ?? 'http://localhost:5173',
  gaMeasurementId: import.meta.env.VITE_GA_MEASUREMENT_ID ?? '',
  enableAnalytics: import.meta.env.VITE_ENABLE_ANALYTICS === 'true',
  enabledOAuthProviders: (import.meta.env.VITE_ENABLED_OAUTH_PROVIDERS ?? 'google')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean),
  timezone: import.meta.env.VITE_TIMEZONE ?? 'Europe/Bucharest',
}

export type OAuthProvider = 'google' | 'facebook' | 'apple'

export function isOAuthProviderEnabled(provider: OAuthProvider): boolean {
  return env.enabledOAuthProviders.includes(provider)
}
