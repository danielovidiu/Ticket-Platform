import type { ReactNode } from 'react'
import { Container } from './Container'

export function Section({
  children,
  className = '',
  containerClassName = '',
}: {
  children: ReactNode
  className?: string
  containerClassName?: string
}) {
  return (
    <section className={`py-16 md:py-24 ${className}`}>
      <Container className={containerClassName}>{children}</Container>
    </section>
  )
}
