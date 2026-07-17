import { lazy, Suspense, type ReactNode } from 'react'
import { createBrowserRouter } from 'react-router-dom'
import { SiteLayout } from '../components/layout/SiteLayout'
import { NotFoundPage } from './NotFoundPage'
import { Spinner } from '../components/ui/Spinner'

const HomePage = lazy(() => import('../features/home/HomePage').then((m) => ({ default: m.HomePage })))
const MissionPage = lazy(() =>
  import('../features/mission/MissionPage').then((m) => ({ default: m.MissionPage })),
)
const PastProjectsPage = lazy(() =>
  import('../features/projects/PastProjectsPage').then((m) => ({ default: m.PastProjectsPage })),
)
const PastProjectDetailPage = lazy(() =>
  import('../features/projects/PastProjectDetailPage').then((m) => ({
    default: m.PastProjectDetailPage,
  })),
)
const UpcomingProjectsPage = lazy(() =>
  import('../features/projects/UpcomingProjectsPage').then((m) => ({
    default: m.UpcomingProjectsPage,
  })),
)
const UpcomingProjectDetailPage = lazy(() =>
  import('../features/projects/UpcomingProjectDetailPage').then((m) => ({
    default: m.UpcomingProjectDetailPage,
  })),
)
const GalleryPage = lazy(() => import('../features/gallery/GalleryPage').then((m) => ({ default: m.GalleryPage })))
const ContactPage = lazy(() => import('../features/contact/ContactPage').then((m) => ({ default: m.ContactPage })))
const ArtistsIndexPage = lazy(() =>
  import('../features/artists/ArtistsIndexPage').then((m) => ({ default: m.ArtistsIndexPage })),
)
const ArtistDetailPage = lazy(() =>
  import('../features/artists/ArtistDetailPage').then((m) => ({ default: m.ArtistDetailPage })),
)
const FaqPage = lazy(() => import('../features/faq/FaqPage').then((m) => ({ default: m.FaqPage })))
const ContentPageBySlug = lazy(() =>
  import('../features/legal/ContentPageBySlug').then((m) => ({ default: m.ContentPageBySlug })),
)
const AuthCallbackPage = lazy(() =>
  import('../features/auth/AuthCallbackPage').then((m) => ({ default: m.AuthCallbackPage })),
)
const CompleteProfilePage = lazy(() =>
  import('../features/auth/CompleteProfilePage').then((m) => ({ default: m.CompleteProfilePage })),
)

function PageFallback() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Spinner />
    </div>
  )
}

function withSuspense(node: ReactNode) {
  return <Suspense fallback={<PageFallback />}>{node}</Suspense>
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <SiteLayout />,
    errorElement: <NotFoundPage />,
    children: [
      { index: true, element: withSuspense(<HomePage />) },
      { path: 'mission', element: withSuspense(<MissionPage />) },
      { path: 'projects', element: withSuspense(<PastProjectsPage />) },
      { path: 'projects/:slug', element: withSuspense(<PastProjectDetailPage />) },
      { path: 'events', element: withSuspense(<UpcomingProjectsPage />) },
      { path: 'events/:slug', element: withSuspense(<UpcomingProjectDetailPage />) },
      { path: 'gallery', element: withSuspense(<GalleryPage />) },
      { path: 'contact', element: withSuspense(<ContactPage />) },
      { path: 'artists', element: withSuspense(<ArtistsIndexPage />) },
      { path: 'artists/:slug', element: withSuspense(<ArtistDetailPage />) },
      { path: 'faq', element: withSuspense(<FaqPage />) },
      { path: 'legal/:slug', element: withSuspense(<ContentPageBySlug />) },
      { path: 'auth/callback', element: withSuspense(<AuthCallbackPage />) },
      { path: 'complete-profile', element: withSuspense(<CompleteProfilePage />) },
    ],
  },
])
