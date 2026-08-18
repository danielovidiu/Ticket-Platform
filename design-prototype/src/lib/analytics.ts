import { env } from './env'

const CONSENT_KEY = 'cookie-consent'
type ConsentValue = 'accepted' | 'declined'

export function getStoredConsent(): ConsentValue | null {
  const value = localStorage.getItem(CONSENT_KEY)
  return value === 'accepted' || value === 'declined' ? value : null
}

export function setStoredConsent(value: ConsentValue): void {
  localStorage.setItem(CONSENT_KEY, value)
  if (value === 'accepted') {
    initGA()
  }
}

let gaLoaded = false

/**
 * True no-op unless all three hold: a real GA measurement ID is configured,
 * analytics is explicitly enabled for this environment, and the visitor has
 * accepted the cookie consent banner. Safe to call multiple times.
 */
export function initGA(): void {
  if (gaLoaded) return
  if (!env.gaMeasurementId || !env.enableAnalytics) return
  if (getStoredConsent() !== 'accepted') return

  gaLoaded = true

  const script = document.createElement('script')
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${env.gaMeasurementId}`
  document.head.appendChild(script)

  window.dataLayer = window.dataLayer ?? []
  function gtag(...args: unknown[]) {
    window.dataLayer.push(args)
  }
  window.gtag = gtag
  gtag('js', new Date())
  gtag('config', env.gaMeasurementId, { anonymize_ip: true })
}

declare global {
  interface Window {
    dataLayer: unknown[]
    gtag: (...args: unknown[]) => void
  }
}
