export function Spinner({ className = '' }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={`border-paper-300/30 border-t-signal-500 h-6 w-6 animate-spin rounded-full border-2 ${className}`}
    />
  )
}
