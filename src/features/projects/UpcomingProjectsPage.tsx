import { Helmet } from 'react-helmet-async'
import { Link } from 'react-router-dom'
import { useUpcomingProjects } from './api'
import { ProjectGrid } from './components/ProjectGrid'
import { Section } from '../../components/ui/Section'
import { Heading } from '../../components/ui/Heading'
import { SkeletonGrid } from '../../components/ui/SkeletonBlock'
import { EmptyState, ErrorState } from '../../components/ui/EmptyState'
import { pageTitle } from '../../lib/seo'

export function UpcomingProjectsPage() {
  const { data: projects, isLoading, isError } = useUpcomingProjects()

  return (
    <>
      <Helmet>
        <title>{pageTitle('Upcoming Events')}</title>
      </Helmet>
      <Section>
        <Heading level={1} className="mb-10">
          Upcoming Events
        </Heading>

        {isLoading ? (
          <SkeletonGrid />
        ) : isError ? (
          <ErrorState />
        ) : !projects || projects.length === 0 ? (
          <EmptyState title="No upcoming events right now">
            <Link to="/projects" className="underline underline-offset-2">
              Explore past projects
            </Link>
          </EmptyState>
        ) : (
          <ProjectGrid projects={projects} basePath="/events" />
        )}
      </Section>
    </>
  )
}
