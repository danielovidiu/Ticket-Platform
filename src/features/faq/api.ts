import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabaseClient'

export function useFaqItems() {
  return useQuery({
    queryKey: ['faq_items'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('faq_items')
        .select('*')
        .eq('is_published', true)
        .order('sort_order')
      if (error) throw error
      return data
    },
  })
}
