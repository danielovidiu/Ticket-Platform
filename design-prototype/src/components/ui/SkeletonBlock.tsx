export function SkeletonBlock({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-sm bg-ink-800 ${className}`} aria-hidden />
}

export function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i}>
          <SkeletonBlock className="aspect-[3/4] w-full" />
          <SkeletonBlock className="mt-4 h-4 w-2/3" />
          <SkeletonBlock className="mt-2 h-3 w-1/3" />
        </div>
      ))}
    </div>
  )
}
