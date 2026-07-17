import { Link } from 'react-router-dom'
import { Heading } from '../../../components/ui/Heading'
import { Image } from '../../../components/ui/Image'
import { useLatestGalleryItems } from '../../gallery/api'

export function LatestGalleryStrip() {
  const { data: items } = useLatestGalleryItems(8)

  if (!items || items.length === 0) return null

  return (
    <div>
      <div className="mb-8 flex items-end justify-between">
        <Heading level={2}>From the Gallery</Heading>
        <Link to="/gallery" className="text-paper-300 hover:text-paper-50 text-sm underline underline-offset-2">
          View all
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {items.map((item) => (
          <Link key={item.id} to="/gallery">
            <Image
              src={item.thumbnail_url ?? item.media_url}
              alt={item.caption ?? ''}
              aspectClassName="aspect-square"
            />
          </Link>
        ))}
      </div>
    </div>
  )
}
