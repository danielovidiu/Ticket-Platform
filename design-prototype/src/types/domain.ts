import type { Database } from './database.types'

export type Artist = Database['public']['Tables']['artists']['Row']
export type Project = Database['public']['Tables']['projects']['Row']
export type TicketType = Database['public']['Tables']['ticket_types']['Row']
export type GalleryItem = Database['public']['Tables']['gallery_items']['Row']
export type ContentPage = Database['public']['Tables']['content_pages']['Row']
export type FaqItem = Database['public']['Tables']['faq_items']['Row']

export type ProjectWithArtists = Project & {
  project_artists: { artist: Artist }[]
}

export type ProjectWithTicketTypes = Project & {
  ticket_types: TicketType[]
}

export type ArtistWithProjects = Artist & {
  project_artists: { project: Project }[]
}
