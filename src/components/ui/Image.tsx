import { useState } from 'react'

export function Image({
  src,
  alt,
  className = '',
  aspectClassName = 'aspect-[3/4]',
}: {
  src: string | null
  alt: string
  className?: string
  aspectClassName?: string
}) {
  const [loaded, setLoaded] = useState(false)

  return (
    <div className={`relative overflow-hidden bg-ink-800 ${aspectClassName} ${className}`}>
      {src ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          className={`h-full w-full object-cover transition-opacity duration-500 ${
            loaded ? 'opacity-100' : 'opacity-0'
          }`}
        />
      ) : null}
      {!loaded ? <div className="absolute inset-0 animate-pulse bg-ink-800" aria-hidden /> : null}
    </div>
  )
}
