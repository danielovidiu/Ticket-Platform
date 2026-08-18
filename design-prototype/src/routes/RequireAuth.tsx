import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useSession } from '../features/auth/AuthProvider'
import { stashIntendedDestination } from '../features/auth/api'
import { Spinner } from '../components/ui/Spinner'

/**
 * Scaffolded for a future "My Tickets" route — nothing in this slice routes
 * through it yet.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useSession()
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner />
      </div>
    )
  }

  if (!session) {
    stashIntendedDestination(location.pathname)
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}
