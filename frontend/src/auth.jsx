import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { http } from "./api";
import { clearScanQueue } from "./lib/scanQueue";

const AuthCtx = createContext({ user: null, loading: true, refresh: () => {}, logout: () => {} });

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { data } = await http.get("/auth/me");
      setUser(data);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const logout = async () => {
    try { await http.post("/auth/logout"); } catch (e) {
      // Non-fatal: even if server logout fails, clear local state and redirect.
      console.warn("Logout endpoint failed, clearing client state anyway:", e?.message || e);
    }
    // Before the redirect, and outside the try: signing out has to take the door's
    // unsent scans with it whether or not the server was reachable. Door devices are
    // shared between shifts, and a queue that survives sign-out hands the next person a
    // list of the last person's tickets. Everything else this app keeps in localStorage
    // is a preference or a cache of public data and is deliberately left alone.
    clearScanQueue();
    setUser(null);
    window.location.href = "/";
  };

  return <AuthCtx.Provider value={{ user, loading, refresh, logout, setUser }}>{children}</AuthCtx.Provider>;
};

export const useAuth = () => useContext(AuthCtx);

// Sends the user to our /login page, preserving where they came from so we can
// return them there after sign-in.
export const startLogin = (returnPath = "/my-tickets") => {
  window.location.assign("/login?return=" + encodeURIComponent(returnPath));
};
