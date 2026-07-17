import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getStoredConsent, setStoredConsent } from '../../lib/analytics'
import { Button } from './Button'

export function CookieConsentBanner() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    setVisible(getStoredConsent() === null)
  }, [])

  if (!visible) return null

  function choose(value: 'accepted' | 'declined') {
    setStoredConsent(value)
    setVisible(false)
  }

  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      className="bg-ink-900 border-ink-700 fixed inset-x-0 bottom-0 z-50 border-t"
    >
      <div className="mx-auto flex max-w-7xl flex-col items-start gap-4 px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <p className="text-paper-300 text-sm">
          We use non-essential cookies for analytics only with your consent. See our{' '}
          <Link to="/legal/cookie-policy" className="text-paper-50 underline underline-offset-2">
            Cookie Policy
          </Link>
          .
        </p>
        <div className="flex shrink-0 gap-3">
          <Button variant="secondary" className="px-4 py-2" onClick={() => choose('declined')}>
            Decline
          </Button>
          <Button className="px-4 py-2" onClick={() => choose('accepted')}>
            Accept all
          </Button>
        </div>
      </div>
    </div>
  )
}
