import { Link } from 'react-router-dom'
import { AtSign, Music2 } from 'lucide-react'
import { NAV_LINKS, LEGAL_LINKS } from './navLinks'

export function Footer() {
  return (
    <footer className="border-ink-800 border-t">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-10 px-4 py-16 sm:grid-cols-3 sm:px-6 lg:px-8">
        <div>
          <p className="font-display text-lg">Nocturne Assembly</p>
          <p className="text-paper-300 mt-2 text-sm">A music &amp; performance collective.</p>
          <div className="mt-4 flex gap-4">
            <a
              href="https://instagram.com"
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Instagram"
              className="text-paper-300 hover:text-paper-50"
            >
              <AtSign className="h-5 w-5" />
            </a>
            <a
              href="https://soundcloud.com"
              target="_blank"
              rel="noreferrer noopener"
              aria-label="SoundCloud"
              className="text-paper-300 hover:text-paper-50"
            >
              <Music2 className="h-5 w-5" />
            </a>
          </div>
          <a href="mailto:booking@nocturneassembly.example" className="text-paper-300 mt-4 block text-sm underline underline-offset-2">
            booking@nocturneassembly.example
          </a>
        </div>

        <div>
          <p className="text-paper-300 mb-4 text-xs font-medium tracking-widest uppercase">Explore</p>
          <ul className="flex flex-col gap-3 text-sm">
            {NAV_LINKS.map((link) => (
              <li key={link.to}>
                <Link to={link.to} className="text-paper-300 hover:text-paper-50">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="text-paper-300 mb-4 text-xs font-medium tracking-widest uppercase">Legal</p>
          <ul className="flex flex-col gap-3 text-sm">
            {LEGAL_LINKS.map((link) => (
              <li key={link.to}>
                <Link to={link.to} className="text-paper-300 hover:text-paper-50">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="border-ink-800 border-t px-4 py-6 sm:px-6 lg:px-8">
        <p className="text-paper-500 text-xs">
          © {new Date().getFullYear()} Nocturne Assembly. All rights reserved.
        </p>
      </div>
    </footer>
  )
}
