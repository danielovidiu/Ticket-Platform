import { Link } from 'react-router-dom'
import type { Artist } from '../../../types/domain'

export function LineupList({ artists }: { artists: Artist[] }) {
  if (artists.length === 0) return null

  return (
    <ul className="flex flex-wrap gap-3">
      {artists.map((artist) => (
        <li key={artist.id}>
          <Link
            to={`/artists/${artist.slug}`}
            className="border-ink-700 hover:border-paper-50 rounded-full border px-4 py-2 text-sm"
          >
            {artist.name}
          </Link>
        </li>
      ))}
    </ul>
  )
}
