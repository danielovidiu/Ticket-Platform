export const SITE_NAME = 'Nocturne Assembly'

export function pageTitle(title?: string): string {
  return title ? `${title} — ${SITE_NAME}` : SITE_NAME
}
