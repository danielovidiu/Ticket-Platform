import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { http } from "./api";

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
