import type { ReactNode } from 'react'

export function Badge({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-gold-400/40 px-3 py-1 text-xs font-medium tracking-wide text-gold-400 uppercase ${className}`}
    >
      {children}
    </span>
  )
}
