import { useParams, Link } from 'react-router-dom'
import { Helmet } from 'react-helmet-async'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useArtistBySlug } from './api'
import { Section } from '../../components/ui/Section'
import { Heading } from '../../components/ui/Heading'
import { Image } from '../../components/ui/Image'
import { SkeletonBlock } from '../../components/ui/SkeletonBlock'
import { EmptyState, ErrorState } from '../../components/ui/EmptyState'
import { formatEventDate, isInPast } from '../../lib/time'
import { pageTitle } from '../../lib/seo'

export function ArtistDetailPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const { data: artist, isLoading, isError } = useArtistBySlug(slug)

  if (isLoading) {
    return (
      <Section className="max-w-4xl">
        <SkeletonBlock className="aspect-[3/4] w-full max-w-sm" />
        <SkeletonBlock className="mt-8 h-8 w-1/2" />
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

  if (!artist) {
    return (
      <Section className="max-w-4xl">
        <EmptyState title="Artist not found">
          <Link to="/artists" className="underline underline-offset-2">
            Back to Artists
          </Link>
        </EmptyState>
      </Section>
    )
  }

  const upcoming = artist.projects.filter((p) => !isInPast(p.event_date))
  const past = artist.projects.filter((p) => isInPast(p.event_date))

  return (
    <>
      <Helmet>
        <title>{pageTitle(artist.name)}</title>
      </Helmet>
      <Section className="max-w-4xl">
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-[280px_1fr]">
          <Image src={artist.photo_url} alt={artist.name} className="max-w-sm" />
          <div>
            {artist.genre ? (
              <p className="text-signal-500 mb-2 text-xs font-medium tracking-widest uppercase">
                {artist.genre}
              </p>
            ) : null}
            <Heading level={1} className="mb-2">
              {artist.name}
            </Heading>
            {artist.role ? <p className="text-paper-300 mb-6 text-sm">{artist.role}</p> : null}

            {artist.bio ? (
              <div className="prose-invert prose max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{artist.bio}</ReactMarkdown>
              </div>
            ) : null}

            {artist.links.length > 0 ? (
              <ul className="mt-6 flex flex-wrap gap-4">
                {artist.links.map((link) => (
                  <li key={link.url}>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-sm underline underline-offset-2"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        {upcoming.length > 0 ? (
          <div className="mt-16">
            <Heading level={3} className="mb-4">
              Upcoming
            </Heading>
            <ProjectList projects={upcoming} basePath="/events" />
          </div>
        ) : null}

        {past.length > 0 ? (
          <div className="mt-16">
            <Heading level={3} className="mb-4">
              Past Projects
            </Heading>
            <ProjectList projects={past} basePath="/projects" />
          </div>
        ) : null}

        {artist.gallery.length > 0 ? (
          <div className="mt-16">
            <Heading level={3} className="mb-4">
              Gallery
            </Heading>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {artist.gallery.map((item) => (
                <Image
                  key={item.id}
                  src={item.thumbnail_url ?? item.media_url}
                  alt={item.caption ?? artist.name}
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

function ProjectList({
  projects,
  basePath,
}: {
  projects: { slug: string; title: string; event_date: string }[]
  basePath: string
}) {
  return (
    <ul className="border-ink-700 divide-ink-700 divide-y border-t">
      {projects.map((project) => (
        <li key={project.slug}>
          <Link
            to={`${basePath}/${project.slug}`}
            className="hover:text-signal-500 flex items-center justify-between py-4"
          >
            <span>{project.title}</span>
            <span className="text-paper-300 text-sm">{formatEventDate(project.event_date)}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
