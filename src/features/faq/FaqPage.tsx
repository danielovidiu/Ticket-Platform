import { Helmet } from 'react-helmet-async'
import { useFaqItems } from './api'
import { Section } from '../../components/ui/Section'
import { Heading } from '../../components/ui/Heading'
import { AccordionItem } from '../../components/ui/Accordion'
import { SkeletonBlock } from '../../components/ui/SkeletonBlock'
import { EmptyState, ErrorState } from '../../components/ui/EmptyState'
import { pageTitle } from '../../lib/seo'

export function FaqPage() {
  const { data: items, isLoading, isError } = useFaqItems()

  return (
    <>
      <Helmet>
        <title>{pageTitle('FAQ')}</title>
      </Helmet>
      <Section className="max-w-3xl">
        <Heading level={1} className="mb-10">
          Frequently Asked Questions
        </Heading>

        {isLoading ? (
          <div className="flex flex-col gap-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonBlock key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : isError ? (
          <ErrorState />
        ) : !items || items.length === 0 ? (
          <EmptyState title="No FAQs yet" />
        ) : (
          <div>
            {items.map((item) => (
              <AccordionItem key={item.id} question={item.question} answer={item.answer} />
            ))}
          </div>
        )}
      </Section>
    </>
  )
}
