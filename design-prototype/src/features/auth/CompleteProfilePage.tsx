import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useNavigate } from 'react-router-dom'
import { useSession } from './AuthProvider'
import { supabase } from '../../lib/supabaseClient'
import { popIntendedDestination } from './api'
import { Button } from '../../components/ui/Button'
import { Section } from '../../components/ui/Section'
import { Heading } from '../../components/ui/Heading'

const schema = z.object({
  full_name: z.string().min(2, 'Please enter your name').max(120),
  // E.164-ish check; a stricter validation library can replace this later.
  phone: z
    .string()
    .min(7, 'Please enter a valid phone number')
    .max(20)
    .regex(/^\+?[0-9 ()-]+$/, 'Please enter a valid phone number'),
})

type FormValues = z.infer<typeof schema>

export function CompleteProfilePage() {
  const { user, profile, refreshProfile } = useSession()
  const navigate = useNavigate()
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { full_name: profile?.full_name ?? '', phone: '' },
  })

  async function onSubmit(values: FormValues) {
    if (!user) return
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: values.full_name, phone: values.phone })
      .eq('id', user.id)

    if (error) {
      setError('root', { message: 'Could not save your details. Please try again.' })
      return
    }

    await refreshProfile()
    navigate(popIntendedDestination(), { replace: true })
  }

  return (
    <Section className="max-w-lg">
      <Heading level={2} className="mb-2">
        Complete your profile
      </Heading>
      <p className="text-paper-300 mb-8 text-sm">
        We need a phone number on file before you can buy tickets — it's used only for order and
        entry support.
      </p>
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-5">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Full name</span>
          <input
            {...register('full_name')}
            className="border-ink-700 bg-ink-900 rounded-sm border px-4 py-3 text-sm focus:border-signal-500 focus:outline-none"
          />
          {errors.full_name ? <span className="text-signal-500 text-xs">{errors.full_name.message}</span> : null}
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Phone number</span>
          <input
            {...register('phone')}
            placeholder="+40 7xx xxx xxx"
            className="border-ink-700 bg-ink-900 rounded-sm border px-4 py-3 text-sm focus:border-signal-500 focus:outline-none"
          />
          {errors.phone ? <span className="text-signal-500 text-xs">{errors.phone.message}</span> : null}
        </label>
        {errors.root ? <p className="text-signal-500 text-xs">{errors.root.message}</p> : null}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Continue'}
        </Button>
      </form>
    </Section>
  )
}
