import { Helmet } from 'react-helmet-async'
import { usePastProjects } from './api'
import { ProjectGrid } from './components/ProjectGrid'
import { Section } from '../../components/ui/Section'
import { Heading } from '../../components/ui/Heading'
import { SkeletonGrid } from '../../components/ui/SkeletonBlock'
import { EmptyState, ErrorState } from '../../components/ui/EmptyState'
import { pageTitle } from '../../lib/seo'

export function PastProjectsPage() {
  const { data: projects, isLoading, isError } = usePastProjects()

  return (
    <>
      <Helmet>
        <title>{pageTitle('Past Projects')}</title>
      </Helmet>
      <Section>
        <Heading level={1} className="mb-10">
          Past Projects
        </Heading>

        {isLoading ? (
          <SkeletonGrid />
        ) : isError ? (
          <ErrorState />
        ) : !projects || projects.length === 0 ? (
          <EmptyState title="No past projects yet" />
        ) : (
          <ProjectGrid projects={projects} basePath="/projects" />
        )}
      </Section>
    </>
  )
}
