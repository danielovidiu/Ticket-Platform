import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";

const KEY = "ss_consent";
const VERSION = 1;

/** Lightweight consent notice. The app currently sets only a strictly-necessary
 * session cookie (no analytics), so this is an acknowledgement + privacy-policy
 * front door. If analytics is ever added, gate its initialization on
 * getConsent().analytics === true rather than firing on page load. */
export function getConsent() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || "null");
    if (c && c.version === VERSION) return c;
  } catch {
    /* ignore */
  }
  return null;
}

export default function CookieConsent() {
  const [show, setShow] = useState(false);
  useEffect(() => { setShow(!getConsent()); }, []);

  const decide = (analytics) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: VERSION, analytics, at: new Date().toISOString() }));
    } catch {
      /* ignore */
    }
    setShow(false);
  };

  if (!show) return null;
  return (
    <div className="fixed bottom-0 inset-x-0 z-[70] bg-[#0F0F0F] border-t border-white/15 px-6 py-4">
      <div className="max-w-[1400px] mx-auto flex flex-col md:flex-row md:items-center gap-3 md:gap-6">
        <p className="text-xs text-zinc-300 leading-relaxed flex-1">
          We use only essential cookies to keep you signed in and process ticket orders. We don't
          run third-party tracking. See our <Link to="/cookie-policy" className="underline">Cookie Policy</Link>.
        </p>
        <div className="flex gap-2 shrink-0">
          <button onClick={() => decide(false)} data-testid="consent-ok" className="btn-accent !py-2 !px-4 !text-xs">Got it</button>
        </div>
      </div>
    </div>
  );
}
