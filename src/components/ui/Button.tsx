import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router-dom'

type Variant = 'primary' | 'secondary' | 'ghost'

const variantClasses: Record<Variant, string> = {
  primary: 'bg-signal-500 text-paper-50 hover:bg-signal-600',
  secondary: 'border border-paper-300/30 text-paper-50 hover:border-paper-50',
  ghost: 'text-paper-50 hover:text-signal-500',
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-sm px-6 py-3 text-sm font-medium tracking-wide uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-40'

export function Button({
  variant = 'primary',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; children: ReactNode }) {
  return (
    <button className={`${base} ${variantClasses[variant]} ${className}`} {...props}>
      {children}
    </button>
  )
}

export function ButtonLink({
  variant = 'primary',
  className = '',
  children,
  ...props
}: LinkProps & { variant?: Variant; children: ReactNode }) {
  return (
    <Link className={`${base} ${variantClasses[variant]} ${className}`} {...props}>
      {children}
    </Link>
  )
}
