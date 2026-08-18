import { useEffect } from 'react'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'
import type { GalleryItemWithRefs } from '../api'

export function Lightbox({
  items,
  index,
  onClose,
  onNavigate,
}: {
  items: GalleryItemWithRefs[]
  index: number
  onClose: () => void
  onNavigate: (index: number) => void
}) {
  const item = items[index]

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') onNavigate((index + 1) % items.length)
      if (e.key === 'ArrowLeft') onNavigate((index - 1 + items.length) % items.length)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [index, items.length, onClose, onNavigate])

  if (!item) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Gallery lightbox"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-4"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="text-paper-50 hover:text-signal-500 absolute top-4 right-4"
      >
        <X className="h-8 w-8" />
      </button>

      <button
        type="button"
        onClick={() => onNavigate((index - 1 + items.length) % items.length)}
        aria-label="Previous"
        className="text-paper-50 hover:text-signal-500 absolute left-4"
      >
        <ChevronLeft className="h-8 w-8" />
      </button>

      <div className="max-h-[85vh] max-w-4xl">
        {item.media_type === 'video' ? (
          <video src={item.media_url} controls autoPlay className="max-h-[85vh] max-w-full" />
        ) : (
          <img src={item.media_url} alt={item.caption ?? ''} className="max-h-[85vh] max-w-full object-contain" />
        )}
        {item.caption ? <p className="text-paper-300 mt-3 text-center text-sm">{item.caption}</p> : null}
      </div>

      <button
        type="button"
        onClick={() => onNavigate((index + 1) % items.length)}
        aria-label="Next"
        className="text-paper-50 hover:text-signal-500 absolute right-4"
      >
        <ChevronRight className="h-8 w-8" />
      </button>
    </div>
  )
}
