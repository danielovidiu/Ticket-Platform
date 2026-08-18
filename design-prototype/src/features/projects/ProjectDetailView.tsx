import { useParams, Link } from 'react-router-dom'
import { Helmet } from 'react-helmet-async'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useProjectBySlug } from './api'
import { LineupList } from './components/LineupList'
import { TicketTierList } from './components/TicketTierList'
import { Section } from '../../components/ui/Section'
import { Heading } from '../../components/ui/Heading'
import { Image } from '../../components/ui/Image'
import { Button } from '../../components/ui/Button'
import { SkeletonBlock } from '../../components/ui/SkeletonBlock'
import { EmptyState, ErrorState } from '../../components/ui/EmptyState'
import { formatEventDateTime } from '../../lib/time'
import { pageTitle } from '../../lib/seo'

export function ProjectDetailView({ variant, listPath }: { variant: 'past' | 'upcoming'; listPath: string }) {
  const { slug = '' } = useParams<{ slug: string }>()
  const { data: project, isLoading, isError } = useProjectBySlug(slug)

  if (isLoading) {
    return (
      <Section className="max-w-4xl">
        <SkeletonBlock className="aspect-[16/9] w-full" />
        <SkeletonBlock className="mt-8 h-10 w-2/3" />
      </Section>
    )
  }

  if (isError) {
    return (
      <Section className="max-w-4xl">
        <ErrorState />
      </Section>
    )
  }

  if (!project) {
    return (
      <Section className="max-w-4xl">
        <EmptyState title="Project not found">
          <Link to={listPath} className="underline underline-offset-2">
            Back to {variant === 'past' ? 'Past Projects' : 'Upcoming Events'}
          </Link>
        </EmptyState>
      </Section>
    )
  }

  return (
    <>
      <Helmet>
        <title>{pageTitle(project.title)}</title>
      </Helmet>
      <Image src={project.cover_image_url} alt={project.title} aspectClassName="aspect-[16/7]" />
      <Section className="max-w-4xl">
        <p className="text-signal-500 mb-2 text-sm font-medium tracking-widest uppercase">
          {formatEventDateTime(project.event_date)}
          {project.venue_name ? ` · ${project.venue_name}` : ''}
        </p>
        <Heading level={1} className="mb-8">
          {project.title}
        </Heading>

        {variant === 'upcoming' ? (
          <div className="mb-10">
            <Button disabled title="Online ticketing launches soon">
              Get Tickets
            </Button>
            <p className="text-paper-300 mt-2 text-xs">Online ticketing launches soon.</p>
          </div>
        ) : null}

        {project.description ? (
          <div className="prose-invert prose mb-10 max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{project.description}</ReactMarkdown>
          </div>
        ) : null}

        {project.artists.length > 0 ? (
          <div className="mb-10">
            <Heading level={3} className="mb-4">
              Lineup
            </Heading>
            <LineupList artists={project.artists} />
          </div>
        ) : null}

        {variant === 'upcoming' && project.ticketTypes.length > 0 ? (
          <div className="mb-10">
            <Heading level={3} className="mb-4">
              Tickets
            </Heading>
            <TicketTierList ticketTypes={project.ticketTypes} />
          </div>
        ) : null}

        {project.gallery.length > 0 ? (
          <div>
            <Heading level={3} className="mb-4">
              Gallery
            </Heading>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {project.gallery.map((item) => (
                <Image
                  key={item.id}
                  src={item.thumbnail_url ?? item.media_url}
                  alt={item.caption ?? project.title}
                  aspectClassName="aspect-square"
                />
              ))}
            </div>
          </div>
        ) : null}
      </Section>
    </>
  )
}
