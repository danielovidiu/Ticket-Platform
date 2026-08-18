import { Helmet } from 'react-helmet-async'
import { useNextUpcomingProject } from '../projects/api'
import { HeroNextEvent } from './components/HeroNextEvent'
import { FeaturedArtists } from './components/FeaturedArtists'
import { MissionTeaser } from './components/MissionTeaser'
import { LatestGalleryStrip } from './components/LatestGalleryStrip'
import { Section } from '../../components/ui/Section'
import { SkeletonBlock } from '../../components/ui/SkeletonBlock'
import { pageTitle } from '../../lib/seo'

export function HomePage() {
  const { data: nextProject, isLoading } = useNextUpcomingProject()

  return (
    <>
      <Helmet>
        <title>{pageTitle()}</title>
      </Helmet>

      {isLoading ? <SkeletonBlock className="h-[70vh] w-full" /> : <HeroNextEvent project={nextProject ?? null} />}

      <Section className="flex flex-col gap-24">
        <FeaturedArtists />
        <MissionTeaser />
        <LatestGalleryStrip />
      </Section>
    </>
  )
}
