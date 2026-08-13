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
import html
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


# What each notice kind is called, in the subject line and in the banner above the
# admin's message. Adding a kind (a price change, say) is one entry here plus one in
# server.NOTICE_KINDS.
_NOTICE_HEADLINES = {
    "venue": ("Venue changed", "The location has changed"),
    "time": ("Time changed", "The time has changed"),
    "lineup": ("Lineup updated", "The lineup has changed"),
    "cancelled": ("Cancelled", "This event is cancelled"),
}


def _esc(v) -> str:
    """Escape anything bound for the notice's HTML.

    The other templates in this file interpolate DB values raw. This one carries an
    admin-typed free-text message, so it escapes — an apostrophe or a stray `<` in a
    hand-written note must not be able to restructure the email.
    """
    return html.escape(str(v or ""), quote=True)


def _paragraphs(text: str) -> str:
    """Admin message -> paragraphs. Blank lines split, single newlines become <br>."""
    blocks = [b.strip() for b in _esc(text).split("\n\n") if b.strip()]
    return "".join(
        f'<p style="margin:0 0 12px;font-size:15px;line-height:1.5">'
        f'{b.replace(chr(10), "<br>")}</p>'
        for b in blocks
    )


def _fact_row(label: str, value: str) -> str:
    if not value:
        return ""
    return (
        f'<tr><td style="padding:4px 12px 4px 0;font-size:12px;color:#888;'
        f'text-transform:uppercase;letter-spacing:1px;white-space:nowrap;'
        f'vertical-align:top">{_esc(label)}</td>'
        f'<td style="padding:4px 0;font-size:14px">{_esc(value)}</td></tr>'
    )


def _tpl_event_notice(p):
    """A change announcement for people already holding a ticket.

    The body is written by an admin; everything around it is derived from the event, so
    the recipient can tell which show this is about before reading a word. Transactional
    — it carries no unsubscribe link, unlike the newsletter templates, because it is
    about a ticket the recipient already holds.
    """
    ev = p.get("event", {})
    kind = p.get("kind", "")
    subject_word, banner = _NOTICE_HEADLINES.get(kind, ("Update", "Something has changed"))
    title = ev.get("title", "")
    cancelled = kind == "cancelled"
    accent = "#b00020" if cancelled else "#111"

    image = (
        f'<img src="{_esc(ev["image_url"])}" alt="" width="512" '
        f'style="width:100%;max-width:512px;height:auto;display:block;margin:0 0 20px">'
        if ev.get("image_url") else ""
    )

    lineup = ", ".join(ev.get("lineup") or [])
    facts = (
        _fact_row("When", ev.get("when", ""))
        + _fact_row("Doors", ev.get("doors", ""))
        + _fact_row("Where", ev.get("where", ""))
        + _fact_row("Lineup", lineup)
    )
    facts_block = (
        f'<table style="width:100%;border-collapse:collapse;margin:20px 0">{facts}</table>'
        if facts else ""
    )

    cta = (
        f'<p><a href="{_esc(p.get("tickets_url", ""))}" style="display:inline-block;'
        f'background:#111;color:#fff;padding:12px 20px;text-decoration:none">'
        f'{"View your tickets" if not cancelled else "View your account"}</a></p>'
    )

    return f"{subject_word} — {title}", _wrap(
        title or "Event update",
        f'{image}'
        f'<p style="margin:0 0 16px;font-size:13px;font-weight:bold;text-transform:uppercase;'
        f'letter-spacing:1px;color:{accent}">{_esc(banner)}</p>'
        f'{_paragraphs(p.get("message", ""))}'
        f'{facts_block}'
        f'{cta}'
        f'<p style="font-size:12px;color:#888">You are receiving this because you hold a '
        f'ticket for this event.</p>',
    )


def _order_rows(order):
    return "".join(
        f'<tr><td style="padding:4px 0">{i.get("name","")}'
        + (f' · {i["size"]}' if i.get("size") else "")
        + f'</td><td style="text-align:center">{i.get("quantity",1)}</td>'
        f'<td style="text-align:right">{float(i.get("line_total_ron",0)):.2f} RON</td></tr>'
        for i in order.get("items", [])
    )


def _tpl_shop_order_paid(p):
    """Doubles as the receipt: the emailed summary an order confirmation has to carry
    under EU distance-selling rules, with the VAT split shown."""
    o = p.get("order", {})
    addr = o.get("shipping_address", {})
    ship_to = ", ".join(filter(None, [
        addr.get("full_name", ""), addr.get("line1", ""), addr.get("line2", ""),
        addr.get("postal_code", ""), addr.get("city", ""), addr.get("country", ""),
    ]))
    return f"Order confirmed — {o.get('order_id', '')}", _wrap(
        "Thank you for your order",
        f'<p>We have your payment. You will get another email when it ships.</p>'
        f'<table style="width:100%;border-collapse:collapse;font-size:14px">{_order_rows(o)}</table>'
        f'<hr style="border:none;border-top:1px solid #eee;margin:12px 0">'
        f'<p style="font-size:14px">Subtotal: {float(o.get("subtotal_ron", 0)):.2f} RON<br>'
        f'Shipping ({o.get("shipping_zone", "")}): {float(o.get("shipping_ron", 0)):.2f} RON<br>'
        f'<strong>Total: {float(o.get("total_ron", 0)):.2f} RON</strong><br>'
        f'<span style="color:#888">Includes VAT ({int(float(o.get("vat_rate", 0.19)) * 100)}%): '
        f'{float(o.get("vat_amount_ron", 0)):.2f} RON</span></p>'
        f'<p style="font-size:13px">Shipping to: {ship_to}</p>'
        + (f'<p style="font-size:12px;color:#888">Invoice #{o["invoice_no"]} is on your orders page.</p>'
           if o.get("invoice_no") else "")
        + f'<p><a href="{p.get("orders_url", "")}" style="display:inline-block;background:#111;'
          f'color:#fff;padding:12px 20px;text-decoration:none">View your orders</a></p>',
    )


def _tpl_shop_order_shipped(p):
    o = p.get("order", {})
    tracking = o.get("tracking_number") or ""
    carrier = o.get("carrier") or ""
    return f"Your order has shipped — {o.get('order_id', '')}", _wrap(
        "On its way",
        f'<p>Your order is with the courier.</p>'
        + (f'<p style="font-size:14px">{carrier} tracking: <strong>{tracking}</strong></p>'
           if tracking else "")
        + f'<table style="width:100%;border-collapse:collapse;font-size:14px">{_order_rows(o)}</table>'
        f'<p><a href="{p.get("orders_url", "")}" style="display:inline-block;background:#111;'
        f'color:#fff;padding:12px 20px;text-decoration:none">View your orders</a></p>',
    )


TEMPLATES = {
    "verify_email": _tpl_verify_email,
    "password_reset": _tpl_password_reset,
    "newsletter_confirm": _tpl_newsletter_confirm,
    "ticket_delivery": _tpl_ticket_delivery,
    "event_notice": _tpl_event_notice,
    "shop_order_paid": _tpl_shop_order_paid,
    "shop_order_shipped": _tpl_shop_order_shipped,
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
