"""
What the editor is told it may upload, and why it is sometimes less than we can store.

`MAX_UPLOAD_BYTES` is 100 MB and the route really will store that much. On a serverless
platform the editor still cannot send it: the request body is refused at the edge, at
roughly 4.5 MB, before any of our code runs. The browser-straight-to-blob route exists to
step around that, and while it is not working the honest ceiling is the small one.

Reporting 100 MB in that state is not a harmless overestimate. The editor accepts a 90 MB
file, uploads for a minute, and loses it — the failure arrives after the work, which is
the worst place to put it.
"""
import pytest
import requests

from support import API, TIMEOUT

from server import MAX_UPLOAD_BYTES, PLATFORM_BODY_LIMIT_BYTES, _upload_limits

pytestmark = [pytest.mark.integration, pytest.mark.xdist_group("test_upload_limits")]


class TestTheAdvertisedCeiling:
    """The pure decision, asked about deployments this one is not in."""

    def test_local_disk_gets_the_full_ceiling(self):
        # A VPS or a laptop: the bytes come straight to us, so our limit is the limit.
        assert _upload_limits(is_local=True, direct_enabled=False) == (MAX_UPLOAD_BYTES, False)

    def test_blob_without_the_direct_route_gets_the_platform_limit(self):
        # The case this file exists for. Every byte has to fit in a request body.
        max_bytes, direct = _upload_limits(is_local=False, direct_enabled=False)
        assert direct is False
        assert max_bytes == PLATFORM_BODY_LIMIT_BYTES
        assert max_bytes < MAX_UPLOAD_BYTES, "advertising the full ceiling here loses uploads"

    def test_blob_with_the_direct_route_gets_the_full_ceiling(self):
        # The file never passes through this process, so the body limit does not apply.
        assert _upload_limits(is_local=False, direct_enabled=True) == (MAX_UPLOAD_BYTES, True)

    def test_the_flag_defaults_on(self):
        # It shipped off while /api/blob-upload did not answer. It answers now, so a
        # blob deployment that sets nothing gets the large ceiling rather than the small
        # one — the point of the whole exercise.
        import server
        assert server.DIRECT_BLOB_UPLOAD is True

    def test_the_flag_alone_does_not_enable_direct_upload(self):
        # Local storage has no blob to upload to; the flag must not switch the editor
        # onto a route that cannot exist here.
        _, direct = _upload_limits(is_local=True, direct_enabled=True)
        assert direct is False

    def test_the_platform_limit_is_under_the_documented_figure(self):
        # Set below ~4.5 MB rather than at it: the edge rejects, and a request that is
        # exactly at a limit is a request that sometimes is not.
        assert PLATFORM_BODY_LIMIT_BYTES < 4.5 * 1024 * 1024


class TestTheEndpointAgrees:
    def test_config_reports_what_the_decision_says(self, editor_headers):
        r = requests.get(f"{API}/uploads/config", headers=editor_headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        body = r.json()

        # Whatever this deployment is, the two must not disagree — that is the bug the
        # route had, where the number came from a different place than the flag.
        assert (body["max_bytes"], body["direct_upload"]) in {
            (MAX_UPLOAD_BYTES, True),
            (MAX_UPLOAD_BYTES, False),
            (PLATFORM_BODY_LIMIT_BYTES, False),
        }
        if not body["direct_upload"] and body["max_bytes"] == MAX_UPLOAD_BYTES:
            # Only legitimate on local disk. Asserted so a blob deployment that starts
            # reporting this is caught here rather than by a failed upload.
            from server import storage
            assert storage.is_local()

    def test_it_needs_an_editor(self):
        r = requests.get(f"{API}/uploads/config", timeout=TIMEOUT)
        assert r.status_code in (401, 403), r.text
