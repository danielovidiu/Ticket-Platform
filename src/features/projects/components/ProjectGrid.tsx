import { Card } from '../../../components/ui/Card'
import { formatEventDate } from '../../../lib/time'
import type { Project } from '../../../types/domain'

export function ProjectGrid({ projects, basePath }: { projects: Project[]; basePath: string }) {
  return (
    <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
      {projects.map((project) => (
        <Card
          key={project.id}
          to={`${basePath}/${project.slug}`}
          imageSrc={project.cover_image_url}
          imageAlt={project.title}
          eyebrow={formatEventDate(project.event_date)}
          title={project.title}
          meta={project.venue_name}
        />
      ))}
    </div>
  )
}
