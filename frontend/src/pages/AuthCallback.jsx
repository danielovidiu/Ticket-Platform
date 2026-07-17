import React, { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { http } from "../api";
import { useAuth } from "../auth";

// REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
export default function AuthCallback() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const processed = useRef(false);

  useEffect(() => {
    if (processed.current) return;
    processed.current = true;

    const hash = window.location.hash || "";
    const match = hash.match(/session_id=([^&]+)/);
    if (!match) {
      navigate("/");
      return;
    }
    const sessionId = decodeURIComponent(match[1]);
    (async () => {
      try {
        const { data } = await http.post("/auth/session", { session_id: sessionId });
        setUser(data.user);
        window.history.replaceState(null, "", window.location.pathname);
        const target = localStorage.getItem("auth_return_to") || "/my-tickets";
        localStorage.removeItem("auth_return_to");
        navigate(target, { state: { user: data.user }, replace: true });
      } catch (e) {
        console.error("Auth failed", e);
        navigate("/");
      }
    })();
  }, [navigate, setUser]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-400" data-testid="auth-processing">
        Authenticating…
      </div>
    </div>
  );
}
