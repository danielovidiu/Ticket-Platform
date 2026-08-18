import { Link } from 'react-router-dom'
import { Image } from '../../../components/ui/Image'
import { Heading } from '../../../components/ui/Heading'
import { ButtonLink } from '../../../components/ui/Button'
import { formatEventDateTime } from '../../../lib/time'
import type { Artist, Project } from '../../../types/domain'

export function HeroNextEvent({ project }: { project: (Project & { project_artists: { artist: Artist }[] }) | null }) {
  if (!project) {
    return (
      <div className="relative flex min-h-[70vh] items-center border-b border-ink-800">
        <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
          <p className="text-signal-500 mb-4 text-sm font-medium tracking-widest uppercase">
            Nocturne Assembly
          </p>
          <Heading level={1} className="max-w-2xl">
            A music &amp; performance collective.
          </Heading>
          <ButtonLink to="/projects" className="mt-8 inline-flex">
            Explore Past Projects
          </ButtonLink>
        </div>
      </div>
    )
  }

  const lineup = project.project_artists.map((link) => link.artist.name).join(', ')

  return (
    <div className="border-ink-800 relative min-h-[70vh] border-b">
      <div className="absolute inset-0">
        <Image
          src={project.cover_image_url}
          alt={project.title}
          aspectClassName="aspect-auto h-full"
          className="h-full"
        />
        <div className="from-ink-950 absolute inset-0 bg-gradient-to-t via-transparent to-transparent" />
      </div>
      <div className="relative mx-auto flex min-h-[70vh] max-w-7xl flex-col justify-end px-4 py-16 sm:px-6 lg:px-8">
        <p className="text-signal-500 mb-4 text-sm font-medium tracking-widest uppercase">
          {formatEventDateTime(project.event_date)}
          {project.venue_name ? ` · ${project.venue_name}` : ''}
        </p>
        <Heading level={1} className="max-w-2xl">
          {project.title}
        </Heading>
        {lineup ? <p className="text-paper-300 mt-4 max-w-xl text-sm">{lineup}</p> : null}
        <div className="mt-8 flex gap-4">
          <ButtonLink to={`/events/${project.slug}`}>Get Tickets</ButtonLink>
          <Link
            to={`/events/${project.slug}`}
            className="text-paper-50 hover:text-signal-500 inline-flex items-center text-sm underline underline-offset-2"
          >
            View details
          </Link>
        </div>
      </div>
    </div>
  )
}
