import { Helmet } from 'react-helmet-async'
import { useArtists } from './api'
import { Section } from '../../components/ui/Section'
import { Heading } from '../../components/ui/Heading'
import { Card } from '../../components/ui/Card'
import { SkeletonGrid } from '../../components/ui/SkeletonBlock'
import { EmptyState, ErrorState } from '../../components/ui/EmptyState'
import { pageTitle } from '../../lib/seo'

export function ArtistsIndexPage() {
  const { data: artists, isLoading, isError } = useArtists()

  return (
    <>
      <Helmet>
        <title>{pageTitle('Artists')}</title>
      </Helmet>
      <Section>
        <Heading level={1} className="mb-10">
          Artists
        </Heading>

        {isLoading ? (
          <SkeletonGrid />
        ) : isError ? (
          <ErrorState />
        ) : !artists || artists.length === 0 ? (
          <EmptyState title="No artists published yet" />
        ) : (
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {artists.map((artist) => (
              <Card
                key={artist.id}
                to={`/artists/${artist.slug}`}
                imageSrc={artist.photo_url}
                imageAlt={artist.name}
                eyebrow={artist.genre ?? undefined}
                title={artist.name}
                meta={artist.role}
              />
            ))}
          </div>
        )}
      </Section>
    </>
  )
}
