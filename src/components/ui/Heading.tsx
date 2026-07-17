import type { ElementType, ReactNode } from 'react'

const sizes = {
  1: 'text-display-1 font-display font-medium',
  2: 'text-display-2 font-display font-medium',
  3: 'text-display-3 font-display font-medium',
  4: 'text-display-4 font-display font-medium',
} as const

export function Heading({
  as,
  level = 2,
  children,
  className = '',
}: {
  as?: ElementType
  level?: keyof typeof sizes
  children: ReactNode
  className?: string
}) {
  const Tag = as ?? (`h${level}` as ElementType)
  return <Tag className={`${sizes[level]} ${className}`}>{children}</Tag>
}
