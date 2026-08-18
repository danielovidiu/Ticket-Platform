import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabaseClient'
import type { Artist, TicketType } from '../../types/domain'

export function usePastProjects() {
  return useQuery({
    queryKey: ['projects', 'past'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .eq('is_published', true)
        .lt('event_date', new Date().toISOString())
        .order('event_date', { ascending: false })
      if (error) throw error
      return data
    },
  })
}

export function useUpcomingProjects() {
  return useQuery({
    queryKey: ['projects', 'upcoming'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .eq('is_published', true)
        .gte('event_date', new Date().toISOString())
        .order('event_date', { ascending: true })
      if (error) throw error
      return data
    },
  })
}

export function useNextUpcomingProject() {
  return useQuery({
    queryKey: ['projects', 'next'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('projects')
        .select('*, project_artists(artist:artists(*))')
        .eq('is_published', true)
        .gte('event_date', new Date().toISOString())
        .order('event_date', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (error) throw error
      return data as unknown as
        | (import('../../types/domain').Project & { project_artists: { artist: Artist }[] })
        | null
    },
  })
}

export function useProjectBySlug(slug: string) {
  return useQuery({
    queryKey: ['projects', slug],
    queryFn: async () => {
      const { data: project, error } = await supabase
        .from('projects')
        .select('*')
        .eq('slug', slug)
        .eq('is_published', true)
        .maybeSingle()
      if (error) throw error
      if (!project) return null

      const [{ data: artistLinks }, { data: ticketTypes }, { data: gallery }] = await Promise.all([
        supabase
          .from('project_artists')
          .select('artist:artists(*)')
          .eq('project_id', project.id)
          .order('billing_order') as unknown as Promise<{ data: { artist: Artist }[] | null }>,
        supabase
          .from('ticket_types')
          .select('*')
          .eq('project_id', project.id)
          .eq('is_active', true)
          .order('wave_order') as unknown as Promise<{ data: TicketType[] | null }>,
        supabase
          .from('gallery_items')
          .select('*')
          .eq('project_id', project.id)
          .eq('is_published', true)
          .order('sort_order'),
      ])

      return {
        ...project,
        artists: (artistLinks ?? []).map((link) => link.artist).filter(Boolean),
        ticketTypes: ticketTypes ?? [],
        gallery: gallery ?? [],
      }
    },
    enabled: !!slug,
  })
}
