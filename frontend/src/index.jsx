import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import App from "@/App";

/* No QueryClientProvider here.
 *
 * @tanstack/react-query wrapped the whole tree from the first commit and nothing ever
 * called useQuery or useMutation — `grep -rn "useQuery\|useMutation" src` returned
 * nothing — so the provider carried 52 kB of query-core into the entry chunk to hold
 * state no component asked for. Every fetch in this app goes through the axios instance
 * in api.js, and the two places that needed caching built their own: lib/nav.js keeps a
 * shared promise plus a localStorage seed, lib/corePageHeader.js keeps one per tab.
 *
 * Adding it back is a real option — Admin refetches /admin/events from four separate
 * components — but it should arrive with the call sites that use it, not before them.
 */

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
