import { Link, useRouteError } from 'react-router-dom'
import { Section } from '../components/ui/Section'
import { Heading } from '../components/ui/Heading'

export function NotFoundPage() {
  const error = useRouteError()
  console.error(error)

  return (
    <Section className="max-w-2xl text-center">
      <Heading level={1} className="mb-4">
        Page not found
      </Heading>
      <p className="text-paper-300 mb-8 text-sm">The page you're looking for doesn't exist.</p>
      <Link to="/" className="underline underline-offset-2">
        Back to Home
      </Link>
    </Section>
  )
}
