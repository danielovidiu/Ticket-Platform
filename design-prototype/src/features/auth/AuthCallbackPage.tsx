import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { popIntendedDestination } from './api'
import { Spinner } from '../../components/ui/Spinner'

export function AuthCallbackPage() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function resolve() {
      const { data, error: sessionError } = await supabase.auth.getSession()
      if (cancelled) return

      if (sessionError || !data.session) {
        setError('We could not complete sign-in. Please try again.')
        return
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('phone')
        .eq('id', data.session.user.id)
        .maybeSingle()

      if (cancelled) return

      if (!profile?.phone) {
        navigate('/complete-profile', { replace: true })
      } else {
        navigate(popIntendedDestination(), { replace: true })
      }
    }

    resolve()
    return () => {
      cancelled = true
    }
  }, [navigate])

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
      {error ? (
        <p className="text-paper-300 text-sm">{error}</p>
      ) : (
        <>
          <Spinner />
          <p className="text-paper-300 text-sm">Signing you in…</p>
        </>
      )}
    </div>
  )
}
