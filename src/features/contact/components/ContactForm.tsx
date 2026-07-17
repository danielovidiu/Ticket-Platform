import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { submitContactMessage } from '../api'
import { Button } from '../../../components/ui/Button'

const schema = z.object({
  name: z.string().min(2, 'Please enter your name').max(80),
  email: z.string().email('Please enter a valid email'),
  subject: z.string().min(2, 'Please enter a subject').max(120),
  message: z.string().min(10, 'Please add a bit more detail').max(2000),
  // Honeypot: real visitors never fill this in. A stopgap only — real
  // CAPTCHA + rate limiting are deferred to a later admin-infra slice.
  company: z.string().max(0).optional(),
})

type FormValues = z.infer<typeof schema>

export function ContactForm() {
  const [submitted, setSubmitted] = useState(false)
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<FormValues>({ resolver: zodResolver(schema) })

  async function onSubmit(values: FormValues) {
    if (values.company) {
      // Honeypot tripped — pretend success, write nothing.
      setSubmitted(true)
      reset()
      return
    }
    try {
      await submitContactMessage(values)
      setSubmitted(true)
      reset()
    } catch {
      setError('root', {
        message: 'Something went wrong sending your message. Please email us directly instead.',
      })
    }
  }

  if (submitted) {
    return (
      <div className="border-ink-700 rounded-sm border py-10 text-center">
        <p className="font-display text-xl">Thank you — your message is on its way.</p>
        <p className="text-paper-300 mt-2 text-sm">We'll get back to you soon.</p>
        <button
          type="button"
          onClick={() => setSubmitted(false)}
          className="text-paper-300 hover:text-paper-50 mt-4 text-sm underline underline-offset-2"
        >
          Send another message
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Name</span>
          <input
            {...register('name')}
            className="border-ink-700 bg-ink-900 rounded-sm border px-4 py-3 text-sm focus:border-signal-500 focus:outline-none"
          />
          {errors.name ? <span className="text-signal-500 text-xs">{errors.name.message}</span> : null}
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Email</span>
          <input
            type="email"
            {...register('email')}
            className="border-ink-700 bg-ink-900 rounded-sm border px-4 py-3 text-sm focus:border-signal-500 focus:outline-none"
          />
          {errors.email ? <span className="text-signal-500 text-xs">{errors.email.message}</span> : null}
        </label>
      </div>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium">Subject</span>
        <input
          {...register('subject')}
          className="border-ink-700 bg-ink-900 rounded-sm border px-4 py-3 text-sm focus:border-signal-500 focus:outline-none"
        />
        {errors.subject ? <span className="text-signal-500 text-xs">{errors.subject.message}</span> : null}
      </label>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium">Message</span>
        <textarea
          rows={6}
          {...register('message')}
          className="border-ink-700 bg-ink-900 rounded-sm border px-4 py-3 text-sm focus:border-signal-500 focus:outline-none"
        />
        {errors.message ? <span className="text-signal-500 text-xs">{errors.message.message}</span> : null}
      </label>

      {/* Honeypot field, hidden from sighted/keyboard users via CSS, not display:none (some bots skip those). */}
      <div className="absolute -left-[9999px]" aria-hidden="true">
        <label>
          Company
          <input {...register('company')} tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      {errors.root ? <p className="text-signal-500 text-sm">{errors.root.message}</p> : null}

      <Button type="submit" disabled={isSubmitting} className="self-start">
        {isSubmitting ? 'Sending…' : 'Send message'}
      </Button>
    </form>
  )
}
