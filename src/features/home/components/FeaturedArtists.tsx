import { Link } from 'react-router-dom'
import { Heading } from '../../../components/ui/Heading'
import { Card } from '../../../components/ui/Card'
import { SkeletonGrid } from '../../../components/ui/SkeletonBlock'
import { useFeaturedArtists } from '../../artists/api'

export function FeaturedArtists() {
  const { data: artists, isLoading } = useFeaturedArtists()

  if (!isLoading && (!artists || artists.length === 0)) return null

  return (
    <div>
      <div className="mb-8 flex items-end justify-between">
        <Heading level={2}>Featured Artists</Heading>
        <Link to="/artists" className="text-paper-300 hover:text-paper-50 text-sm underline underline-offset-2">
          View all
        </Link>
      </div>

      {isLoading ? (
        <SkeletonGrid count={3} />
      ) : (
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {artists!.map((artist) => (
            <Card
              key={artist.id}
              to={`/artists/${artist.slug}`}
              imageSrc={artist.photo_url}
              imageAlt={artist.name}
              eyebrow={artist.genre ?? undefined}
              title={artist.name}
            />
          ))}
        </div>
      )}
    </div>
  )
}
