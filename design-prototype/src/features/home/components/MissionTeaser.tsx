import { Link } from 'react-router-dom'
import { Heading } from '../../../components/ui/Heading'
import { useContentPage } from '../../legal/api'

export function MissionTeaser() {
  const { data: page } = useContentPage('mission')

  if (!page) return null

  return (
    <div className="max-w-2xl">
      <Heading level={2} className="mb-4">
        Our Mission
      </Heading>
      {page.excerpt ? <p className="text-paper-300 text-lg leading-relaxed">{page.excerpt}</p> : null}
      <Link to="/mission" className="mt-4 inline-block text-sm underline underline-offset-2">
        Read more
      </Link>
    </div>
  )
}
