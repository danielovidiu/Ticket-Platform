import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabaseClient'

export function useContentPage(slug: string) {
  return useQuery({
    queryKey: ['content_pages', slug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('content_pages')
        .select('*')
        .eq('slug', slug)
        .eq('is_published', true)
        .maybeSingle()
      if (error) throw error
      return data
    },
  })
}
