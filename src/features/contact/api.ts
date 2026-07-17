import { supabase } from '../../lib/supabaseClient'

export interface ContactFormValues {
  name: string
  email: string
  subject: string
  message: string
}

export async function submitContactMessage(values: ContactFormValues) {
  const { error } = await supabase.from('contact_messages').insert({
    name: values.name,
    email: values.email,
    subject: values.subject,
    message: values.message,
  })
  if (error) throw error
}
