import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabaseClient'

export interface GalleryItemWithRefs {
  id: string
  media_type: 'image' | 'video'
  media_url: string
  thumbnail_url: string | null
  caption: string | null
  tags: string[]
  project: { slug: string; title: string } | null
  created_at: string
}

export function useGalleryItems() {
  return useQuery({
    queryKey: ['gallery_items'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('gallery_items')
        .select('id, media_type, media_url, thumbnail_url, caption, tags, created_at, project:projects(slug, title)')
        .eq('is_published', true)
        .order('created_at', { ascending: false })
        .limit(200)
      if (error) throw error
      return (data ?? []) as unknown as GalleryItemWithRefs[]
    },
  })
}

export function useLatestGalleryItems(limit = 8) {
  return useQuery({
    queryKey: ['gallery_items', 'latest', limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('gallery_items')
        .select('*')
        .eq('is_published', true)
        .order('created_at', { ascending: false })
        .limit(limit)
      if (error) throw error
      return data
    },
  })
}
