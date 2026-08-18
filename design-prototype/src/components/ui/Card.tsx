import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Image } from './Image'

export function Card({
  to,
  imageSrc,
  imageAlt,
  eyebrow,
  title,
  meta,
  children,
}: {
  to: string
  imageSrc: string | null
  imageAlt: string
  eyebrow?: string
  title: string
  meta?: ReactNode
  children?: ReactNode
}) {
  return (
    <Link to={to} className="group block">
      <Image src={imageSrc} alt={imageAlt} className="transition-transform duration-500 group-hover:scale-[1.02]" />
      <div className="pt-4">
        {eyebrow ? (
          <p className="text-signal-500 mb-1 text-xs font-medium tracking-widest uppercase">{eyebrow}</p>
        ) : null}
        <h3 className="font-display text-xl">{title}</h3>
        {meta ? <p className="text-paper-300 mt-1 text-sm">{meta}</p> : null}
        {children}
      </div>
    </Link>
  )
}
