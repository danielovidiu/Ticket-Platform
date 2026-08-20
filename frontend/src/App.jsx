import "@/App.css";
import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "./auth";
import { CartProvider } from "./lib/cart";
import Layout from "./components/Layout";
import DynamicPage from "./pages/DynamicPage";
import Events from "./pages/Events";
import EventDetail from "./pages/EventDetail";
import Checkout from "./pages/Checkout";
import CheckoutSuccess from "./pages/CheckoutSuccess";
import MyTickets from "./pages/MyTickets";
import Artists from "./pages/Artists";
import ArtistDetail from "./pages/ArtistDetail";
import Archive from "./pages/Archive";
import Gallery from "./pages/Gallery";
import AlbumPage from "./pages/AlbumPage";
import Shop from "./pages/Shop";
import ProductDetail from "./pages/ProductDetail";
import Cart from "./pages/Cart";
import ShopCheckout from "./pages/ShopCheckout";
import ShopSuccess from "./pages/ShopSuccess";
import MyOrders from "./pages/MyOrders";
import Login from "./pages/Login";
import CompleteProfile from "./pages/CompleteProfile";
import VerifyEmail from "./pages/VerifyEmail";
import ResetPassword from "./pages/ResetPassword";
import Settings from "./pages/Settings";
import NewsletterConfirm from "./pages/NewsletterConfirm";
import NewsletterUnsubscribe from "./pages/NewsletterUnsubscribe";
/* Admin, CMSEditor and Scan are the only routes not imported at the top of this file.
   They are staff-only and they are big — together about a quarter of the application
   source — so importing them here would put the CMS editor in front of every visitor
   who came to buy a ticket. The loaders they wrap are shared with prefetchBackstage(),
   which warms exactly these chunks for signed-in staff; see pages/backstage.js. */
import { loadAdmin, loadCMSEditor, loadScan } from "./pages/backstage";
import ThemeLoader from "./components/ThemeLoader";
import CookieConsent from "./components/CookieConsent";

const Admin = lazy(loadAdmin);
const CMSEditor = lazy(loadCMSEditor);
const Scan = lazy(loadScan);

/** Shown only while a split chunk is in flight, which for staff is usually never —
 * prefetchBackstage() has normally already fetched it. Deliberately the same line the
 * three pages show while their own auth call resolves, so a slow load reads as one wait
 * rather than a flicker between two different spinners. */
const RouteFallback = () => (
  <div className="p-16 text-center font-mono-x text-ink-4">Loading…</div>
);

// Pages a signed-in user with an unfinished profile may still reach. The completion
// form itself obviously, the auth flows (so signing out or verifying still works), and
// the legal pages the form links to.
const PROFILE_GATE_EXEMPT = ["/complete-profile", "/login", "/verify", "/reset-password",
                             "/terms", "/privacy", "/cookie-policy", "/newsletter"];

/** Name, surname and phone are mandatory on every account. Anyone signed in without
 * them is sent to fill them in — including Google sign-ups, since no provider gives us
 * a phone number. The same rule is enforced server-side when a reservation is created,
 * so this is a redirect for the user's benefit rather than the control itself. */
function ProfileGate({ children }) {
  const { user, loading } = useAuth();
  const { pathname, search } = useLocation();

  if (loading || !user || user.profile_complete) return children;
  if (PROFILE_GATE_EXEMPT.some((p) => pathname.startsWith(p))) return children;
  return <Navigate to={`/complete-profile?return=${encodeURIComponent(pathname + search)}`} replace />;
}

function AppRouter() {
  return (
    <Layout>
      <ProfileGate>
      <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* Which page this is, is a CMS setting — not the slug "home". */}
        <Route path="/" element={<DynamicPage home />} />
        {/* CMS pages live at the root: /mission, not /p/mission.
            /mission, /contact, /terms, /privacy and /cookie-policy used to be declared
            here one by one, purely because the generic page route was namespaced under
            /p/. They are ordinary CMS pages and now resolve through this one route.

            Declaring a bare ":slug" alongside two dozen static routes is safe: React
            Router ranks matches by specificity, not by source order, so a static segment
            like "/events" always beats it. The corollary is that a page whose slug spells
            a built-in path can never be reached — see RESERVED_SLUGS in cms_routes.py,
            which refuses to create one.

            /p/:slug is not handled here at all. vercel.json redirects it permanently, so
            old links resolve with a real 301 instead of a client-side bounce. */}
        <Route path=":slug" element={<DynamicPage />} />
        <Route path="/events" element={<Events />} />
        <Route path="/events/:slug" element={<EventDetail />} />
        <Route path="/checkout/:reservationId" element={<Checkout />} />
        <Route path="/checkout/success" element={<CheckoutSuccess />} />
        <Route path="/checkout/cancel" element={<Events />} />
        <Route path="/my-tickets" element={<MyTickets />} />
        <Route path="/artists" element={<Artists />} />
        <Route path="/artists/:slug" element={<ArtistDetail />} />
        <Route path="/archive" element={<Archive />} />
        <Route path="/gallery" element={<Gallery />} />
        {/* One album per slug. This used to be the single sitewide gallery's own
            address, which redirected any slug but its configured one. */}
        <Route path="/gallery/:slug" element={<AlbumPage />} />
        {/* Webshop. /shop/checkout and /shop/success are declared before /shop/:slug so
            they aren't swallowed by the product route. */}
        <Route path="/shop" element={<Shop />} />
        <Route path="/shop/checkout" element={<ShopCheckout />} />
        <Route path="/shop/success" element={<ShopSuccess />} />
        <Route path="/shop/:slug" element={<ProductDetail />} />
        <Route path="/cart" element={<Cart />} />
        <Route path="/my-orders" element={<MyOrders />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/scan" element={<Scan />} />
        <Route path="/cms" element={<CMSEditor />} />
        <Route path="/login" element={<Login />} />
        <Route path="/complete-profile" element={<CompleteProfile />} />
        <Route path="/verify" element={<VerifyEmail />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/newsletter/confirm" element={<NewsletterConfirm />} />
        <Route path="/newsletter/unsubscribe" element={<NewsletterUnsubscribe />} />
      </Routes>
      </Suspense>
      </ProfileGate>
    </Layout>
  );
}

export default function App() {
  return (
    <div className="App">
      <BrowserRouter>
        <AuthProvider>
          {/* Inside AuthProvider: the cart belongs to the signed-in account and is
              refetched when that changes. */}
          <CartProvider>
            <ThemeLoader />
            {/* Through the tokens, so a toast doesn't stay a black box on a light site. */}
            <Toaster position="top-right" toastOptions={{ style: { background: "var(--bg)", border: "1px solid rgb(var(--text-rgb) / 0.2)", color: "var(--text)", borderRadius: "var(--radius)" } }} />
            <AppRouter />
            <CookieConsent />
          </CartProvider>
        </AuthProvider>
      </BrowserRouter>
    </div>
  );
}
