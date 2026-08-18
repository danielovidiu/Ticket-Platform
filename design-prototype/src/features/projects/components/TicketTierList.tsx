import { Badge } from '../../../components/ui/Badge'
import type { TicketType } from '../../../types/domain'

function formatPrice(cents: number, currency: string) {
  return `${(cents / 100).toFixed(0)} ${currency}`
}

export function TicketTierList({ ticketTypes }: { ticketTypes: TicketType[] }) {
  if (ticketTypes.length === 0) return null

  return (
    <div className="border-ink-700 divide-ink-700 divide-y border-y">
      {ticketTypes.map((tier) => {
        const soldOut = tier.quantity_total !== null && tier.quantity_sold >= tier.quantity_total
        return (
          <div key={tier.id} className="flex items-center justify-between py-4">
            <div>
              <p className="font-medium">{tier.name}</p>
              {soldOut ? <Badge className="mt-1">Sold Out</Badge> : null}
            </div>
            <p className="font-display text-lg">{formatPrice(tier.price_cents, tier.currency)}</p>
          </div>
        )
      })}
    </div>
  )
}
