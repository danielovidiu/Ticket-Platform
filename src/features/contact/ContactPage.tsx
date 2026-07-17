import { Helmet } from 'react-helmet-async'
import { ContactForm } from './components/ContactForm'
import { Section } from '../../components/ui/Section'
import { Heading } from '../../components/ui/Heading'
import { pageTitle } from '../../lib/seo'

export function ContactPage() {
  return (
    <>
      <Helmet>
        <title>{pageTitle('Contact')}</title>
      </Helmet>
      <Section className="max-w-2xl">
        <Heading level={1} className="mb-4">
          Get in touch
        </Heading>
        <p className="text-paper-300 mb-10 text-sm">
          Booking enquiries, press, or general questions — send us a message and we'll reply soon.
        </p>
        <ContactForm />
      </Section>
    </>
  )
}
