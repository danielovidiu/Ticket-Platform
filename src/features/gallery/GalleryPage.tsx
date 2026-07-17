import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Helmet } from 'react-helmet-async'
import { Play } from 'lucide-react'
import { useGalleryItems } from './api'
import { Lightbox } from './components/Lightbox'
import { Section } from '../../components/ui/Section'
import { Heading } from '../../components/ui/Heading'
import { Image } from '../../components/ui/Image'
import { SkeletonGrid } from '../../components/ui/SkeletonBlock'
import { EmptyState, ErrorState } from '../../components/ui/EmptyState'
import { pageTitle } from '../../lib/seo'

export function GalleryPage() {
  const { data: items, isLoading, isError } = useGalleryItems()
  const [searchParams, setSearchParams] = useSearchParams()
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  const activeProject = searchParams.get('project') ?? ''
  const activeTag = searchParams.get('tag') ?? ''

  const { projects, tags } = useMemo(() => {
    const projectSet = new Map<string, string>()
    const tagSet = new Set<string>()
    for (const item of items ?? []) {
      if (item.project) projectSet.set(item.project.slug, item.project.title)
      item.tags.forEach((tag) => tagSet.add(tag))
    }
    return { projects: Array.from(projectSet.entries()), tags: Array.from(tagSet) }
  }, [items])

  const filtered = useMemo(() => {
    return (items ?? []).filter((item) => {
      if (activeProject && item.project?.slug !== activeProject) return false
      if (activeTag && !item.tags.includes(activeTag)) return false
      return true
    })
  }, [items, activeProject, activeTag])

  function updateFilter(key: 'project' | 'tag', value: string) {
    const next = new URLSearchParams(searchParams)
    if (value) next.set(key, value)
    else next.delete(key)
    setSearchParams(next)
  }

  return (
    <>
      <Helmet>
        <title>{pageTitle('Gallery')}</title>
      </Helmet>
      <Section>
        <Heading level={1} className="mb-8">
          Gallery
        </Heading>

        {(projects.length > 0 || tags.length > 0) && (
          <div className="mb-8 flex flex-wrap gap-4">
            {projects.length > 0 ? (
              <select
                value={activeProject}
                onChange={(e) => updateFilter('project', e.target.value)}
                className="border-ink-700 bg-ink-900 rounded-sm border px-3 py-2 text-sm"
              >
                <option value="">All projects</option>
                {projects.map(([slug, title]) => (
                  <option key={slug} value={slug}>
                    {title}
                  </option>
                ))}
              </select>
            ) : null}
            {tags.length > 0 ? (
              <select
                value={activeTag}
                onChange={(e) => updateFilter('tag', e.target.value)}
                className="border-ink-700 bg-ink-900 rounded-sm border px-3 py-2 text-sm"
              >
                <option value="">All tags</option>
                {tags.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
            ) : null}
            {(activeProject || activeTag) && (
              <button
                type="button"
                onClick={() => setSearchParams({})}
                className="text-paper-300 hover:text-paper-50 text-sm underline underline-offset-2"
              >
                Clear filters
              </button>
            )}
          </div>
        )}

        {isLoading ? (
          <SkeletonGrid count={9} />
        ) : isError ? (
          <ErrorState />
        ) : filtered.length === 0 ? (
          <EmptyState title="No media matches these filters">
            {activeProject || activeTag ? (
              <button
                type="button"
                onClick={() => setSearchParams({})}
                className="underline underline-offset-2"
              >
                Clear filters
              </button>
            ) : null}
          </EmptyState>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {filtered.map((item, i) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setLightboxIndex(i)}
                className="relative block text-left"
              >
                <Image
                  src={item.thumbnail_url ?? item.media_url}
                  alt={item.caption ?? ''}
                  aspectClassName="aspect-square"
                />
                {item.media_type === 'video' ? (
                  <Play className="absolute top-1/2 left-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 text-white drop-shadow" />
                ) : null}
              </button>
            ))}
          </div>
        )}
      </Section>

      {lightboxIndex !== null ? (
        <Lightbox
          items={filtered}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
        />
      ) : null}
    </>
  )
}
