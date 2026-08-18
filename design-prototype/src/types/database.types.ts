// Hand-written to match supabase/migrations/*.sql. Once the project is linked
// (see SETUP.md), regenerate with:
//   npm run gen:types
// and this file becomes fully generated — do not hand-edit past that point.

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          email: string | null
          full_name: string | null
          phone: string | null
          phone_verified: boolean
          role: 'customer' | 'admin' | 'door_staff'
          marketing_opt_in: boolean
          created_at: string
          updated_at: string
        }
        Insert: Partial<Database['public']['Tables']['profiles']['Row']> & { id: string }
        Update: Partial<Database['public']['Tables']['profiles']['Row']>
        Relationships: []
      }
      artists: {
        Row: {
          id: string
          slug: string
          name: string
          photo_url: string | null
          bio: string | null
          role: string | null
          genre: string | null
          links: { label: string; url: string }[]
          is_featured: boolean
          is_published: boolean
          created_at: string
          updated_at: string
        }
        Insert: Partial<Database['public']['Tables']['artists']['Row']>
        Update: Partial<Database['public']['Tables']['artists']['Row']>
        Relationships: []
      }
      projects: {
        Row: {
          id: string
          slug: string
          title: string
          event_date: string
          event_end_date: string | null
          venue_name: string | null
          venue_address: string | null
          cover_image_url: string | null
          description: string | null
          is_published: boolean
          created_at: string
          updated_at: string
        }
        Insert: Partial<Database['public']['Tables']['projects']['Row']>
        Update: Partial<Database['public']['Tables']['projects']['Row']>
        Relationships: []
      }
      project_artists: {
        Row: {
          id: string
          project_id: string
          artist_id: string
          billing_order: number
          created_at: string
        }
        Insert: Partial<Database['public']['Tables']['project_artists']['Row']>
        Update: Partial<Database['public']['Tables']['project_artists']['Row']>
        Relationships: []
      }
      ticket_types: {
        Row: {
          id: string
          project_id: string
          name: string
          price_cents: number
          currency: string
          wave_order: number
          quantity_total: number | null
          quantity_sold: number
          sales_start_at: string | null
          sales_end_at: string | null
          access_valid_from: string | null
          access_valid_until: string | null
          max_per_user: number | null
          is_private: boolean
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: Partial<Database['public']['Tables']['ticket_types']['Row']>
        Update: Partial<Database['public']['Tables']['ticket_types']['Row']>
        Relationships: []
      }
      discount_codes: {
        Row: {
          id: string
          code: string
          description: string | null
          discount_type: 'percent' | 'fixed'
          discount_value: number
          max_uses: number | null
          uses_count: number
          valid_from: string | null
          valid_until: string | null
          scope: 'global' | 'event' | 'ticket_type'
          scope_ref: string | null
          is_active: boolean
          created_at: string
        }
        Insert: Partial<Database['public']['Tables']['discount_codes']['Row']>
        Update: Partial<Database['public']['Tables']['discount_codes']['Row']>
        Relationships: []
      }
      special_links: {
        Row: {
          id: string
          token: string
          project_id: string | null
          ticket_type_id: string | null
          price_override_cents: number | null
          max_uses: number | null
          uses_count: number
          expires_at: string | null
          created_by: string | null
          is_active: boolean
          created_at: string
        }
        Insert: Partial<Database['public']['Tables']['special_links']['Row']>
        Update: Partial<Database['public']['Tables']['special_links']['Row']>
        Relationships: []
      }
      orders: {
        Row: {
          id: string
          user_id: string | null
          project_id: string | null
          status: 'pending' | 'reserved' | 'paid' | 'cancelled' | 'refunded' | 'expired'
          currency: string
          subtotal_cents: number | null
          discount_cents: number
          total_cents: number | null
          discount_code_id: string | null
          special_link_id: string | null
          stripe_checkout_session_id: string | null
          stripe_payment_intent_id: string | null
          invoice_number: string | null
          invoice_provider: string | null
          buyer_email: string | null
          buyer_name: string | null
          buyer_phone: string | null
          reserved_until: string | null
          created_at: string
          updated_at: string
        }
        Insert: Partial<Database['public']['Tables']['orders']['Row']>
        Update: Partial<Database['public']['Tables']['orders']['Row']>
        Relationships: []
      }
      tickets: {
        Row: {
          id: string
          order_id: string | null
          ticket_type_id: string | null
          project_id: string | null
          owner_user_id: string | null
          qr_code_token: string | null
          status: 'valid' | 'checked_in' | 'void' | 'refunded'
          checked_in_at: string | null
          checked_in_by: string | null
          holder_name: string | null
          holder_email: string | null
          created_at: string
        }
        Insert: Partial<Database['public']['Tables']['tickets']['Row']>
        Update: Partial<Database['public']['Tables']['tickets']['Row']>
        Relationships: []
      }
      gallery_items: {
        Row: {
          id: string
          project_id: string | null
          artist_id: string | null
          media_type: 'image' | 'video'
          media_url: string
          thumbnail_url: string | null
          caption: string | null
          tags: string[]
          is_published: boolean
          sort_order: number
          created_at: string
        }
        Insert: Partial<Database['public']['Tables']['gallery_items']['Row']>
        Update: Partial<Database['public']['Tables']['gallery_items']['Row']>
        Relationships: []
      }
      contact_messages: {
        Row: {
          id: string
          name: string
          email: string
          subject: string
          message: string
          status: 'new' | 'read' | 'archived'
          ip_hash: string | null
          user_agent: string | null
          created_at: string
        }
        Insert: Partial<Database['public']['Tables']['contact_messages']['Row']>
        Update: Partial<Database['public']['Tables']['contact_messages']['Row']>
        Relationships: []
      }
      content_pages: {
        Row: {
          id: string
          slug: string
          title: string
          excerpt: string | null
          body: string
          hero_image_url: string | null
          is_published: boolean
          updated_at: string
        }
        Insert: Partial<Database['public']['Tables']['content_pages']['Row']>
        Update: Partial<Database['public']['Tables']['content_pages']['Row']>
        Relationships: []
      }
      faq_items: {
        Row: {
          id: string
          question: string
          answer: string
          sort_order: number
          is_published: boolean
          updated_at: string
        }
        Insert: Partial<Database['public']['Tables']['faq_items']['Row']>
        Update: Partial<Database['public']['Tables']['faq_items']['Row']>
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
