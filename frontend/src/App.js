import React from "react";
import "@/App.css";
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
import Shop from "./pages/Shop";
import ProductDetail from "./pages/ProductDetail";
import Cart from "./pages/Cart";
import ShopCheckout from "./pages/ShopCheckout";
import ShopSuccess from "./pages/ShopSuccess";
import MyOrders from "./pages/MyOrders";
import Admin from "./pages/Admin";
import Scan from "./pages/Scan";
import CMSEditor from "./pages/CMSEditor";
import Login from "./pages/Login";
import CompleteProfile from "./pages/CompleteProfile";
import VerifyEmail from "./pages/VerifyEmail";
import ResetPassword from "./pages/ResetPassword";
import Settings from "./pages/Settings";
import NewsletterConfirm from "./pages/NewsletterConfirm";
import NewsletterUnsubscribe from "./pages/NewsletterUnsubscribe";
import ThemeLoader from "./components/ThemeLoader";
import CookieConsent from "./components/CookieConsent";

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
      <Routes>
        <Route path="/" element={<DynamicPage slugOverride="home" />} />
        <Route path="/mission" element={<DynamicPage slugOverride="mission" />} />
        <Route path="/contact" element={<DynamicPage slugOverride="contact" />} />
        <Route path="/terms" element={<DynamicPage slugOverride="terms" />} />
        <Route path="/privacy" element={<DynamicPage slugOverride="privacy" />} />
        <Route path="/cookie-policy" element={<DynamicPage slugOverride="cookie-policy" />} />
        <Route path="/p/:slug" element={<DynamicPage />} />
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
        {/* The sitewide gallery's own slug. Gallery redirects to the canonical one when
            the slug in the URL isn't the configured one. */}
        <Route path="/gallery/:slug" element={<Gallery />} />
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
            <Toaster theme="dark" position="top-right" toastOptions={{ style: { background: "#050505", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", borderRadius: 0 } }} />
            <AppRouter />
            <CookieConsent />
          </CartProvider>
        </AuthProvider>
      </BrowserRouter>
    </div>
  );
}
