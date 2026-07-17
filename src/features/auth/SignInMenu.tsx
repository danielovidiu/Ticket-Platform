import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { User } from 'lucide-react'
import { useSession } from './AuthProvider'
import { signInWithOAuth, signOut } from './api'
import { isOAuthProviderEnabled, type OAuthProvider } from '../../lib/env'

const PROVIDER_LABELS: Record<OAuthProvider, string> = {
  google: 'Continue with Google',
  facebook: 'Continue with Facebook',
  apple: 'Continue with Apple',
}

export function SignInMenu() {
  const { session, profile } = useSession()
  const location = useLocation()
  const [open, setOpen] = useState(false)

  if (session) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-sm"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <User className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">{profile?.full_name ?? 'Account'}</span>
        </button>
        {open ? (
          <div className="bg-ink-900 border-ink-700 absolute right-0 z-10 mt-2 w-40 border py-2 text-sm shadow-lg">
            <button
              type="button"
              onClick={() => signOut()}
              className="hover:bg-ink-800 block w-full px-4 py-2 text-left"
            >
              Sign out
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-sm" aria-haspopup="menu" aria-expanded={open}>
        Sign in
      </button>
      {open ? (
        <div className="bg-ink-900 border-ink-700 absolute right-0 z-10 mt-2 w-56 border py-2 text-sm shadow-lg">
          {(['google', 'facebook', 'apple'] as const)
            .filter(isOAuthProviderEnabled)
            .map((provider) => (
              <button
                key={provider}
                type="button"
                onClick={() => signInWithOAuth(provider, location.pathname)}
                className="hover:bg-ink-800 block w-full px-4 py-2 text-left"
              >
                {PROVIDER_LABELS[provider]}
              </button>
            ))}
        </div>
      ) : null}
    </div>
  )
}
