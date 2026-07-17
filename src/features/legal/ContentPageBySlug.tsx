import { useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Helmet } from 'react-helmet-async'
import { useContentPage } from './api'
import { Section } from '../../components/ui/Section'
import { Heading } from '../../components/ui/Heading'
import { SkeletonBlock } from '../../components/ui/SkeletonBlock'
import { EmptyState, ErrorState } from '../../components/ui/EmptyState'
import { Image } from '../../components/ui/Image'
import { pageTitle } from '../../lib/seo'

export function ContentPageBySlug({ slug: slugProp }: { slug?: string }) {
  const params = useParams<{ slug: string }>()
  const slug = slugProp ?? params.slug ?? ''
  const { data: page, isLoading, isError } = useContentPage(slug)

  if (isLoading) {
    return (
      <Section className="max-w-3xl">
        <SkeletonBlock className="h-10 w-2/3" />
        <SkeletonBlock className="mt-6 h-4 w-full" />
        <SkeletonBlock className="mt-2 h-4 w-5/6" />
      </Section>
    )
  }

  if (isError) {
    return (
      <Section className="max-w-3xl">
        <ErrorState />
      </Section>
    )
  }

  if (!page) {
    return (
      <Section className="max-w-3xl">
        <EmptyState title="Page not found" />
      </Section>
    )
  }

  return (
    <>
      <Helmet>
        <title>{pageTitle(page.title)}</title>
      </Helmet>
      {page.hero_image_url ? (
        <Image src={page.hero_image_url} alt="" aspectClassName="aspect-[16/6]" />
      ) : null}
      <Section className="max-w-3xl">
        <Heading level={1} className="mb-8">
          {page.title}
        </Heading>
        <div className="prose-invert prose max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{page.body}</ReactMarkdown>
        </div>
      </Section>
    </>
  )
}
