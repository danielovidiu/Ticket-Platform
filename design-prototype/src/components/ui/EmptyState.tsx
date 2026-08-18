import type { ReactNode } from 'react'

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="border-ink-700 rounded-sm border border-dashed py-20 text-center">
      <p className="font-display text-xl">{title}</p>
      {children ? <div className="text-paper-300 mt-3 text-sm">{children}</div> : null}
    </div>
  )
}

export function ErrorState({ message = 'Something went wrong. Please try again.' }: { message?: string }) {
  return (
    <div className="border-signal-500/30 rounded-sm border py-20 text-center">
      <p className="text-paper-300 text-sm">{message}</p>
    </div>
  )
}
