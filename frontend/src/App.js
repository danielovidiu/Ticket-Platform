import React from "react";
import "@/App.css";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
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
import AuthCallback from "./pages/AuthCallback";
import ThemeLoader from "./components/ThemeLoader";

function AppRouter() {
  const loc = useLocation();
  if (loc.hash?.includes("session_id=")) {
    return <AuthCallback />;
  }
  // The CMS editor is a full-screen chrome, no Layout wrapper.
  if (loc.pathname.startsWith("/cms")) {
    return (
      <Routes>
        <Route path="/cms" element={<CMSEditor />} />
      </Routes>
    );
  }
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DynamicPage slugOverride="home" />} />
        <Route path="/mission" element={<DynamicPage slugOverride="mission" />} />
        <Route path="/contact" element={<DynamicPage slugOverride="contact" />} />
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
        </AuthProvider>
      </BrowserRouter>
    </div>
  );
}
