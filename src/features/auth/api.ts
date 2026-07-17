import { supabase } from '../../lib/supabaseClient'
import { env, type OAuthProvider } from '../../lib/env'

const INTENDED_DESTINATION_KEY = 'auth-intended-destination'

export function stashIntendedDestination(path: string) {
  sessionStorage.setItem(INTENDED_DESTINATION_KEY, path)
}

export function popIntendedDestination(): string {
  const dest = sessionStorage.getItem(INTENDED_DESTINATION_KEY)
  sessionStorage.removeItem(INTENDED_DESTINATION_KEY)
  return dest ?? '/'
}

export async function signInWithOAuth(provider: OAuthProvider, currentPath: string) {
  stashIntendedDestination(currentPath)
  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${env.siteUrl}/auth/callback` },
  })
  if (error) throw error
}

export async function signOut() {
  await supabase.auth.signOut()
}
