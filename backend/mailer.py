"""
Mailer abstraction — one send_mail(kind, to, payload) entry point with two backends:

  * Resend (https://resend.com) when RESEND_API_KEY is set — real delivery.
  * db.outbox fallback otherwise — the message is persisted and logged instead of
    sent, so the whole verification/reset/ticket flow is exercisable in dev and in
    this environment without an email provider. Tests read tokens back out of
    db.outbox.

Send failures never raise to the caller: an email that fails to go out must not fail
a registration, a newsletter signup, or (critically) paid-ticket finalization.
"""
import os
import base64
import logging
from datetime import datetime, timezone

import httpx

logger = logging.getLogger("supersanity.mailer")

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "").strip()
MAIL_FROM = os.environ.get("MAIL_FROM", "Supersanity <tickets@supersanity.local>").strip()
PUBLIC_APP_URL = os.environ.get("PUBLIC_APP_URL", "http://localhost:3000").rstrip("/")

_db = None
_log = logger


def init_mailer(db, log=None):
    """Wire the Motor db handle (and optionally the app logger) at startup."""
    global _db, _log
    _db = db
    if log is not None:
        _log = log


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _wrap(title: str, body_html: str) -> str:
    return (
        f'<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;'
        f'padding:24px;color:#111">'
        f'<h1 style="font-size:20px;text-transform:uppercase;letter-spacing:1px">{title}</h1>'
        f'{body_html}'
        f'<hr style="border:none;border-top:1px solid #eee;margin:24px 0">'
        f'<p style="font-size:12px;color:#888">Supersanity — Bucharest music &amp; performance collective.</p>'
        f'</div>'
    )


def _tpl_verify_email(p):
    url = p["verify_url"]
    return "Verify your email", _wrap(
        "Confirm your email",
        f'<p>Welcome to Supersanity. Confirm this address to secure your account.</p>'
        f'<p><a href="{url}" style="display:inline-block;background:#111;color:#fff;'
        f'padding:12px 20px;text-decoration:none">Verify email</a></p>'
        f'<p style="font-size:12px;color:#888">Or paste this link: {url}</p>',
    )


def _tpl_password_reset(p):
    url = p["reset_url"]
    return "Reset your password", _wrap(
        "Reset your password",
        f'<p>Someone requested a password reset for your account. If it wasn\'t you, '
        f'ignore this email — nothing changes.</p>'
        f'<p><a href="{url}" style="display:inline-block;background:#111;color:#fff;'
        f'padding:12px 20px;text-decoration:none">Set a new password</a></p>'
        f'<p style="font-size:12px;color:#888">This link expires in 1 hour. Link: {url}</p>',
    )


def _tpl_newsletter_confirm(p):
    url = p["confirm_url"]
    return "Confirm your newsletter subscription", _wrap(
        "One more step",
        f'<p>Confirm you want Supersanity event announcements at this address.</p>'
        f'<p><a href="{url}" style="display:inline-block;background:#111;color:#fff;'
        f'padding:12px 20px;text-decoration:none">Confirm subscription</a></p>'
        f'<p style="font-size:12px;color:#888">You won\'t receive anything until you confirm. Link: {url}</p>',
    )


def _tpl_ticket_delivery(p):
    ev = p.get("event", {})
    rows = "".join(
        f'<li style="margin:6px 0"><strong>{t.get("wave","")}</strong> — '
        f'<code>{t.get("qr_code","")}</code></li>'
        for t in p.get("tickets", [])
    )
    return f"Your tickets — {ev.get('title','Supersanity')}", _wrap(
        "Your tickets",
        f'<p>You\'re in. Present the QR code(s) at the door for '
        f'<strong>{ev.get("title","")}</strong>'
        + (f' · {ev.get("when")}' if ev.get("when") else "")
        + (f' · {ev.get("where")}' if ev.get("where") else "")
        + f'.</p><ul>{rows}</ul>'
        + (f'<p style="font-size:12px;color:#888">Invoice #{p["invoice_no"]} attached to your account.</p>'
           if p.get("invoice_no") else ""),
    )


TEMPLATES = {
    "verify_email": _tpl_verify_email,
    "password_reset": _tpl_password_reset,
    "newsletter_confirm": _tpl_newsletter_confirm,
    "ticket_delivery": _tpl_ticket_delivery,
}


async def send_mail(kind: str, to: str, payload: dict) -> dict:
    """Render + deliver (or persist to outbox). Returns a small status dict.
    Never raises — logs and returns {'ok': False, ...} on failure."""
    tpl = TEMPLATES.get(kind)
    if tpl is None:
        _log.error("send_mail: unknown kind %r", kind)
        return {"ok": False, "reason": "unknown_kind"}

    try:
        subject, html = tpl(payload)
    except Exception:
        _log.exception("send_mail: template %r failed to render", kind)
        return {"ok": False, "reason": "render_failed"}

    headers = payload.get("headers") or {}
    attachments = payload.get("attachments") or []  # [{filename, content(bytes)}]

    if RESEND_API_KEY:
        try:
            body = {
                "from": MAIL_FROM,
                "to": [to],
                "subject": subject,
                "html": html,
            }
            if headers:
                body["headers"] = headers
            if attachments:
                body["attachments"] = [
                    {"filename": a["filename"],
                     "content": base64.b64encode(a["content"]).decode()}
                    for a in attachments
                ]
            async with httpx.AsyncClient(timeout=15.0) as hc:
                r = await hc.post(
                    "https://api.resend.com/emails",
                    headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
                    json=body,
                )
            if r.status_code >= 300:
                _log.error("send_mail: resend %s -> %s %s", kind, r.status_code, r.text[:200])
                return {"ok": False, "reason": "provider_error", "status": r.status_code}
            return {"ok": True, "provider": "resend", "id": r.json().get("id")}
        except Exception:
            _log.exception("send_mail: resend call failed for %r", kind)
            return {"ok": False, "reason": "provider_exception"}

    # Dev fallback — persist so flows are testable without a provider.
    doc = {
        "outbox_id": f"out_{os.urandom(8).hex()}",
        "kind": kind,
        "to": to,
        "subject": subject,
        "html": html,
        "headers": headers,
        "payload": {k: v for k, v in payload.items() if k != "attachments"},
        "status": "queued",
        "created_at": _now_iso(),
    }
    if _db is not None:
        try:
            await _db.outbox.insert_one(dict(doc))
        except Exception:
            _log.exception("send_mail: outbox insert failed")
    _log.info("MAIL[%s] -> %s : %s", kind, to, subject)
    return {"ok": True, "provider": "outbox", "id": doc["outbox_id"]}
