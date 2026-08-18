import { formatInTimeZone } from 'date-fns-tz'
import { env } from './env'

const TIMEZONE = env.timezone

/** e.g. "Fri, 3 Oct 2026" */
export function formatEventDate(iso: string): string {
  return formatInTimeZone(new Date(iso), TIMEZONE, 'EEE, d MMM yyyy')
}

/** e.g. "19:00" */
export function formatEventTime(iso: string): string {
  return formatInTimeZone(new Date(iso), TIMEZONE, 'HH:mm')
}

/** e.g. "Fri, 3 Oct 2026 · 19:00" */
export function formatEventDateTime(iso: string): string {
  return `${formatEventDate(iso)} · ${formatEventTime(iso)}`
}

export function isInPast(iso: string): boolean {
  return new Date(iso).getTime() < Date.now()
}
