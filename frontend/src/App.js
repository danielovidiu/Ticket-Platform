import React from "react";
import "@/App.css";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider } from "./auth";
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
import Admin from "./pages/Admin";
import Scan from "./pages/Scan";
import CMSEditor from "./pages/CMSEditor";
import Login from "./pages/Login";
import VerifyEmail from "./pages/VerifyEmail";
import ResetPassword from "./pages/ResetPassword";
import Settings from "./pages/Settings";
import NewsletterConfirm from "./pages/NewsletterConfirm";
import NewsletterUnsubscribe from "./pages/NewsletterUnsubscribe";
import ThemeLoader from "./components/ThemeLoader";
import CookieConsent from "./components/CookieConsent";

function AppRouter() {
  return (
    <Layout>
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
        <Route path="/admin" element={<Admin />} />
        <Route path="/scan" element={<Scan />} />
        <Route path="/cms" element={<CMSEditor />} />
        <Route path="/login" element={<Login />} />
        <Route path="/verify" element={<VerifyEmail />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/newsletter/confirm" element={<NewsletterConfirm />} />
        <Route path="/newsletter/unsubscribe" element={<NewsletterUnsubscribe />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <div className="App">
      <BrowserRouter>
        <AuthProvider>
          <ThemeLoader />
          <Toaster theme="dark" position="top-right" toastOptions={{ style: { background: "#050505", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", borderRadius: 0 } }} />
          <AppRouter />
          <CookieConsent />
        </AuthProvider>
      </BrowserRouter>
    </div>
  );
}
