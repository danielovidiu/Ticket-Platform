import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useSession } from '../features/auth/AuthProvider'
import { RequireAuth } from './RequireAuth'

/**
 * Scaffolded for a future "My Tickets" route — nothing in this slice routes
 * through it yet. Wraps RequireAuth and additionally gates on a completed
 * profile (phone captured).
 */
export function RequireCompleteProfile({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <ProfileGate>{children}</ProfileGate>
    </RequireAuth>
  )
}

function ProfileGate({ children }: { children: ReactNode }) {
  const { profile, loading } = useSession()
  if (loading) return null
  if (!profile?.phone) return <Navigate to="/complete-profile" replace />
  return <>{children}</>
}
