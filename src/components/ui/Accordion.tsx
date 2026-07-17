import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'

export function AccordionItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()

  return (
    <div className="border-ink-700 border-b">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 py-6 text-left"
      >
        <span className="font-display text-lg">{question}</span>
        <ChevronDown
          aria-hidden
          className={`h-5 w-5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div id={id} hidden={!open} className="text-paper-300 pb-6 text-sm leading-relaxed">
        {answer}
      </div>
    </div>
  )
}
