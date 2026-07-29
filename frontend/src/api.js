import axios from "axios";

// Empty means "same origin", which is the deployed shape: Vercel routes /api/* to the
// backend service and everything else here, so the browser never leaves the domain and
// the session cookie stays same-site. Local dev sets REACT_APP_BACKEND_URL in .env
// because the two run on different ports. Note the `|| ""`: without it an unset variable
// interpolates as the literal string "undefined" and every call goes to /undefined/api.
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
export const API = `${BACKEND_URL}/api`;

export const http = axios.create({
  baseURL: API,
  withCredentials: true,
});
