import { NavLink } from 'react-router-dom'
import { NAV_LINKS } from './navLinks'
import { SignInMenu } from '../../features/auth/SignInMenu'

export function MobileNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null

  return (
    <div className="bg-ink-950 fixed inset-x-0 top-[73px] bottom-0 z-30 overflow-y-auto lg:hidden">
      <nav className="flex flex-col gap-1 px-6 py-8">
        {NAV_LINKS.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            onClick={onClose}
            className={({ isActive }) =>
              `font-display border-ink-800 border-b py-4 text-3xl ${isActive ? 'text-signal-500' : 'text-paper-50'}`
            }
          >
            {link.label}
          </NavLink>
        ))}
        <div className="mt-8">
          <SignInMenu />
        </div>
      </nav>
    </div>
  )
}
