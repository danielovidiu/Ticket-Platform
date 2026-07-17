import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabaseClient'
import type { Project } from '../../types/domain'

export function useArtists() {
  return useQuery({
    queryKey: ['artists'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('artists')
        .select('*')
        .eq('is_published', true)
        .order('name')
      if (error) throw error
      return data
    },
  })
}

export function useFeaturedArtists(limit = 6) {
  return useQuery({
    queryKey: ['artists', 'featured', limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('artists')
        .select('*')
        .eq('is_published', true)
        .eq('is_featured', true)
        .limit(limit)
      if (error) throw error
      return data
    },
  })
}

export function useArtistBySlug(slug: string) {
  return useQuery({
    queryKey: ['artists', slug],
    queryFn: async () => {
      const { data: artist, error } = await supabase
        .from('artists')
        .select('*')
        .eq('slug', slug)
        .eq('is_published', true)
        .maybeSingle()
      if (error) throw error
      if (!artist) return null

      const [{ data: projectLinks }, { data: gallery }] = await Promise.all([
        supabase
          .from('project_artists')
          .select('project:projects(*)')
          .eq('artist_id', artist.id) as unknown as Promise<{ data: { project: Project }[] | null }>,
        supabase
          .from('gallery_items')
          .select('*')
          .eq('artist_id', artist.id)
          .eq('is_published', true)
          .order('sort_order'),
      ])

      return {
        ...artist,
        projects: (projectLinks ?? []).map((link) => link.project).filter(Boolean),
        gallery: gallery ?? [],
      }
    },
    enabled: !!slug,
  })
}
