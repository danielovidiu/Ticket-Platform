"""
The SMTP backend, exercised against a fake smtplib rather than a live relay.

Unit-style, unlike the rest of this suite: what is worth pinning down here is the shape
of the message handed to the relay — multipart order, attachments, auth, TLS choice —
and standing up a real SMTP server to assert on that would test smtplib, not us.

`mailer` reads its configuration into module globals at import, so each test patches
those globals directly. That mirrors production, where the process is restarted to pick
up a config change.
"""
import smtplib

import pytest

import mailer


PAYLOAD = {"verify_url": "https://example.test/verify?token=abc"}


@pytest.fixture
def anyio_backend():
    """Pin to asyncio. Left to itself anyio parametrizes over trio too, which is not
    installed — the suite would error rather than skip."""
    return "asyncio"


class FakeSMTP:
    """Records what a relay would have been told."""
    instances = []

    def __init__(self, host, port, timeout=None, context=None):
        self.host, self.port, self.timeout = host, port, timeout
        self.started_tls = False
        self.login_args = None
        self.sent = None
        self.quit_called = False
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.quit_called = True
        return False

    def ehlo(self, *a):
        pass

    def starttls(self, context=None):
        self.started_tls = True

    def login(self, user, password):
        self.login_args = (user, password)

    def send_message(self, msg):
        self.sent = msg


@pytest.fixture
def smtp(monkeypatch):
    """Point the mailer at a fake relay with a typical STARTTLS config."""
    FakeSMTP.instances = []
    monkeypatch.setattr(mailer, "SMTP_HOST", "smtp.example.test")
    monkeypatch.setattr(mailer, "SMTP_PORT", 587)
    monkeypatch.setattr(mailer, "SMTP_SECURITY", "starttls")
    monkeypatch.setattr(mailer, "SMTP_USER", "postmaster@example.test")
    monkeypatch.setattr(mailer, "SMTP_PASSWORD", "app-password")
    monkeypatch.setattr(mailer, "RESEND_API_KEY", "")      # SMTP must be the one chosen
    monkeypatch.setattr(mailer, "MAIL_FROM", "Supersanity <tickets@example.test>")
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSMTP)
    return FakeSMTP


class TestDelivery:
    @pytest.mark.anyio
    async def test_sends_and_reports_smtp(self, smtp):
        res = await mailer.send_mail("verify_email", "her@example.test", PAYLOAD)
        assert res["ok"] is True
        assert res["provider"] == "smtp"
        assert len(smtp.instances) == 1

    @pytest.mark.anyio
    async def test_envelope_and_auth(self, smtp):
        await mailer.send_mail("verify_email", "her@example.test", PAYLOAD)
        conn = smtp.instances[0]
        assert (conn.host, conn.port) == ("smtp.example.test", 587)
        assert conn.started_tls is True
        assert conn.login_args == ("postmaster@example.test", "app-password")
        assert conn.quit_called is True                    # connection is not leaked

        msg = conn.sent
        assert msg["To"] == "her@example.test"
        assert msg["From"] == "Supersanity <tickets@example.test>"
        assert msg["Subject"] == "Verify your email"

    @pytest.mark.anyio
    async def test_multipart_alternative_html_last(self, smtp):
        """Clients render the last part they understand, so HTML must come after text."""
        await mailer.send_mail("verify_email", "her@example.test", PAYLOAD)
        msg = smtp.instances[0].sent
        subtypes = [p.get_content_type() for p in msg.walk() if not p.is_multipart()]
        assert subtypes == ["text/plain", "text/html"]

        text = msg.get_body(("plain",)).get_content()
        assert "https://example.test/verify?token=abc" in text
        assert "<" not in text                             # tags stripped, not escaped

    @pytest.mark.anyio
    async def test_table_cells_are_separated_in_text(self, smtp):
        """Both the notice's facts and the shop's line items are tables; without a cell
        separator the text part reads "WhenFri 12 Sep"."""
        await mailer.send_mail("event_notice", "her@example.test", {
            "kind": "venue", "message": "Moved.",
            "event": {"title": "X", "when": "Fri 12 Sep 2026, 22:00", "where": "Control"},
            "tickets_url": "https://example.test/my-tickets",
        })
        text = smtp.instances[0].sent.get_body(("plain",)).get_content()
        assert "WhenFri" not in text
        assert "When\tFri 12 Sep 2026, 22:00" in text

    @pytest.mark.anyio
    async def test_date_and_message_id_present(self, smtp):
        """smtplib adds neither, and their absence is a spam signal."""
        await mailer.send_mail("verify_email", "her@example.test", PAYLOAD)
        msg = smtp.instances[0].sent
        assert msg["Date"]
        assert msg["Message-ID"].startswith("<")

    @pytest.mark.anyio
    async def test_attachments_carry_their_type(self, smtp):
        """Ticket delivery attaches QR PNGs; they must not arrive as octet-stream."""
        await mailer.send_mail("ticket_delivery", "her@example.test", {
            "event": {"title": "NOAPTEA ALBĂ"},
            "tickets": [{"qr_code": "SNTY-1", "wave": "GENERAL"}],
            "attachments": [{"filename": "SNTY-1.png", "content": b"\x89PNG\r\n\x1a\n"}],
        })
        msg = smtp.instances[0].sent
        att = list(msg.iter_attachments())
        assert len(att) == 1
        assert att[0].get_filename() == "SNTY-1.png"
        assert att[0].get_content_type() == "image/png"

    @pytest.mark.anyio
    async def test_custom_headers_survive(self, smtp):
        """The newsletter's one-click unsubscribe rides on these."""
        await mailer.send_mail("newsletter_confirm", "her@example.test", {
            "confirm_url": "https://example.test/c",
            "headers": {"List-Unsubscribe": "<https://example.test/u>"},
        })
        assert smtp.instances[0].sent["List-Unsubscribe"] == "<https://example.test/u>"


class TestConfiguration:
    @pytest.mark.anyio
    async def test_implicit_tls_skips_starttls(self, smtp, monkeypatch):
        monkeypatch.setattr(mailer, "SMTP_SECURITY", "ssl")
        monkeypatch.setattr(mailer, "SMTP_PORT", 465)
        await mailer.send_mail("verify_email", "her@example.test", PAYLOAD)
        assert smtp.instances[0].started_tls is False

    @pytest.mark.anyio
    async def test_no_user_means_no_login(self, smtp, monkeypatch):
        """A local catcher (Mailpit) accepts mail unauthenticated."""
        monkeypatch.setattr(mailer, "SMTP_USER", "")
        await mailer.send_mail("verify_email", "her@example.test", PAYLOAD)
        assert smtp.instances[0].login_args is None

    @pytest.mark.anyio
    async def test_resend_wins_when_both_configured(self, smtp, monkeypatch):
        """HTTP beats SMTP on a serverless host, so Resend takes precedence."""
        monkeypatch.setattr(mailer, "RESEND_API_KEY", "re_test")
        called = {}

        async def _fake_resend(*a, **kw):
            called["yes"] = True
            return {"ok": True, "provider": "resend", "id": "x"}

        monkeypatch.setattr(mailer, "_send_via_resend", _fake_resend)
        res = await mailer.send_mail("verify_email", "her@example.test", PAYLOAD)
        assert res["provider"] == "resend"
        assert called == {"yes": True}
        assert smtp.instances == []


class TestFailure:
    @pytest.mark.anyio
    async def test_relay_error_never_raises(self, smtp, monkeypatch):
        """A dead relay must not take a paid-ticket finalization down with it."""
        def _boom(*a, **kw):
            raise smtplib.SMTPAuthenticationError(535, b"nope")

        monkeypatch.setattr(FakeSMTP, "login", _boom)
        res = await mailer.send_mail("verify_email", "her@example.test", PAYLOAD)
        assert res == {"ok": False, "reason": "provider_exception", "provider": "smtp"}

    @pytest.mark.anyio
    async def test_failure_does_not_fall_through_to_outbox(self, smtp, monkeypatch):
        """Falling back would report success for a message nobody received."""
        def _boom(*a, **kw):
            raise OSError("connection refused")

        monkeypatch.setattr(FakeSMTP, "send_message", _boom)
        res = await mailer.send_mail("verify_email", "her@example.test", PAYLOAD)
        assert res["ok"] is False
        assert res.get("provider") != "outbox"
