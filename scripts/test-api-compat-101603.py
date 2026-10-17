"""2026.10.16.3 — API answers old (2026.9.27.26) and new clients understand.

* An image the SERVER downloaded that is empty / an HTML page / undecodable is
  502 ``image_fetch_failed`` at stage ``image_fetch`` (old clients then fetch the
  image in the browser), never a 500 ``internal_error`` at ``image_decode``.
* The request's OWN bytes (data URL) that are empty / not base64 / not an
  image, or no image at all, are 422 ``invalid_image``, never 400/500.
* ``POST /ai/probe`` is a no-cost stub again (the old popup calls it).
* Provider HTTP 402 -> ``billing_required``; 404 -> ``provider_model_not_found``.
* Image downloads accept gzip/deflate transfer encodings, with the size cap on
  the decoded bytes.
* A client that disconnects mid-upload is a logged 499, not ``http.error 400``.
"""
from __future__ import annotations

import gzip
import http.server
import io
import socket
import sys
import threading
import time
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
import tp_api_harness as harness  # noqa: E402

harness.prepare_env()

import httpx  # noqa: E402
from PIL import Image  # noqa: E402


def _jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (300, 400), (250, 250, 250)).save(buf, "JPEG")
    return buf.getvalue()


JPEG = _jpeg()


class Site(http.server.BaseHTTPRequestHandler):
    """A comic site: normal image, 403, HTML-200, empty body, gzip/deflate, bomb."""

    def log_message(self, *a):
        pass

    def _send(self, status, body, ctype="image/jpeg", encoding=None):
        self.send_response(status)
        self.send_header("content-type", ctype)
        if encoding:
            self.send_header("content-encoding", encoding)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/ok.jpg":
            return self._send(200, JPEG)
        if path == "/403.jpg":
            return self._send(403, b"<h1>Forbidden</h1>", "text/html")
        if path == "/html.jpg":
            return self._send(200, b"<!doctype html><html><body>hotlink</body></html>", "text/html")
        if path == "/html-as-jpeg.jpg":
            return self._send(200, b"<!doctype html><html><body>hotlink</body></html>")
        if path == "/empty.jpg":
            return self._send(200, b"")
        if path == "/trunc.jpg":
            return self._send(200, JPEG[: len(JPEG) // 3])
        if path == "/gzip.jpg":
            return self._send(200, gzip.compress(JPEG), encoding="gzip")
        if path == "/deflate.jpg":
            return self._send(200, zlib.compress(JPEG), encoding="deflate")
        if path == "/rawdeflate.jpg":
            c = zlib.compressobj(wbits=-zlib.MAX_WBITS)
            return self._send(200, c.compress(JPEG) + c.flush(), encoding="deflate")
        if path == "/bomb.jpg":
            return self._send(200, gzip.compress(b"\0" * (3 * 1024 * 1024)), encoding="gzip")
        if path == "/br.jpg":
            return self._send(200, b"\x1b\x00\x00", encoding="br")
        return self._send(404, b"nope", "text/plain")


def _site():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


class ImageAnswers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.site, cls.base = _site()
        cls.server = harness.Server(lens_delay=0.01).__enter__()
        cls.log = harness.EventLog()
        cls.log.install()

    @classmethod
    def tearDownClass(cls):
        cls.server.__exit__(None, None, None)
        cls.site.shutdown()

    def post(self, payload):
        with httpx.Client(timeout=60) as c:
            return c.post(self.server.url + "/v2/engine/runsapi/translate", json=payload,
                          headers={"X-TP-Client-Version": "2026.9.27.26"})

    def url_case(self, name):
        payload = harness.runsapi_payload(1, session="s", src=f"{self.base}/{name}", data_uri="")
        payload.pop("imageDataUri", None)
        return self.post(payload)

    def assert_fetch_failed(self, response, code="image_fetch_failed"):
        self.assertEqual(response.status_code, 502, response.text[:300])
        detail = response.json()["detail"]
        self.assertEqual(detail["stage"], "image_fetch")
        self.assertEqual(detail["code"], code)
        # The old client's browser-fallback trigger reads this field.
        self.assertEqual(detail.get("failedStage", detail["stage"]), "image_fetch")

    def assert_invalid_image(self, response):
        self.assertEqual(response.status_code, 422, response.text[:300])
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], "invalid_image")
        self.assertFalse(detail["retryable"])

    def test_downloaded_image_ok_and_encodings(self):
        for name in ("ok.jpg", "gzip.jpg", "deflate.jpg", "rawdeflate.jpg"):
            with self.subTest(name=name):
                response = self.url_case(name)
                self.assertEqual(response.status_code, 200, (name, response.text[:300]))

    def test_downloaded_non_images_are_image_fetch_502(self):
        self.assert_fetch_failed(self.url_case("403.jpg"), code="image_fetch_http_error")
        for name in ("html.jpg", "html-as-jpeg.jpg", "empty.jpg", "trunc.jpg", "br.jpg"):
            with self.subTest(name=name):
                self.assert_fetch_failed(self.url_case(name))
        internal = [e for e in self.log.events("error.request") if e.get("code") == "internal_error"]
        self.assertEqual(internal, [])

    def test_inline_bad_bytes_and_no_image_are_422(self):
        import base64
        cases = {
            "empty data url": "data:image/png;base64,",
            "not base64": "data:image/png;base64,@@@notbase64@@@",
            "html bytes": "data:image/jpeg;base64," + base64.b64encode(b"<html>no</html>").decode(),
            "truncated jpeg": "data:image/jpeg;base64," + base64.b64encode(JPEG[: len(JPEG) // 3]).decode(),
        }
        for name, uri in cases.items():
            with self.subTest(name=name):
                payload = harness.runsapi_payload(2, session="s", data_uri=uri)
                payload["src"] = uri  # extension sends the data URL as src too
                self.assert_invalid_image(self.post(payload))
        payload = harness.runsapi_payload(3, session="s", data_uri="")
        payload.pop("imageDataUri", None)
        payload["src"] = ""
        self.assert_invalid_image(self.post(payload))

    def test_download_size_cap_applies_to_decoded_bytes(self):
        from backend.utils import images
        from backend.config import settings
        import dataclasses
        small = dataclasses.replace(settings, max_image_bytes=1024 * 1024)
        with patch.object(images, "settings", small):
            with self.assertRaises(images.ImageTooLarge):
                images.download(f"{self.base}/bomb.jpg")
            blob, _ = images.download(f"{self.base}/gzip.jpg")
        self.assertEqual(blob, JPEG)

    def test_ai_probe_stub(self):
        with httpx.Client(timeout=10) as c:
            response = c.post(self.server.url + "/ai/probe",
                              json={"api_key": "sk-secret", "model": "m", "provider": "openai"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": False, "status": "not_tested", "model_capabilities": {}})
        self.assertNotIn("sk-secret", "\n".join(self.log.lines))

    def test_mid_upload_disconnect_is_logged_499(self):
        before = len(self.log.events("request.client_disconnected"))
        errors_before = len(self.log.events("http.error"))
        for path, ctype, body in (
            ("/v2/engine/runsapi/translate", "application/json", b'{"mode":"lens_images","src":"x'),
            ("/v2/engine/runsextension/lens/raw", "multipart/form-data; boundary=XX",
             b'--XX\r\nContent-Disposition: form-data; name="image"; filename="p.img"\r\n'
             b"Content-Type: image/jpeg\r\n\r\n" + b"\0" * 1000),
        ):
            sock = socket.create_connection(("127.0.0.1", self.server.port))
            sock.sendall((f"POST {path} HTTP/1.1\r\nHost: x\r\nContent-Type: {ctype}\r\n"
                          f"Content-Length: 100000\r\nX-TP-Client-Version: 2026.9.27.26\r\n\r\n").encode() + body)
            time.sleep(0.2)
            sock.close()
        deadline = time.time() + 5
        while time.time() < deadline and len(self.log.events("request.client_disconnected")) < before + 2:
            time.sleep(0.05)
        gone = self.log.events("request.client_disconnected")[before:]
        self.assertEqual(len(gone), 2, self.log.lines[-10:])
        self.assertTrue(all(e["status"] == 499 and e["code"] == "client_disconnected"
                            and e["stage"] == "request_body" for e in gone))
        self.assertEqual(len(self.log.events("http.error")), errors_before)

    def test_unparsable_body_is_canonical_400(self):
        with httpx.Client(timeout=10) as c:
            response = c.post(self.server.url + "/v2/engine/runsapi/translate",
                              content=b'{"a":"\xff\xfe"}', headers={"content-type": "application/json"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"]["code"], "invalid_request")


class DuplicateImageNeedsNoSecondLensSlot(unittest.TestCase):
    """A retried/duplicate page joins the Lens answer already cached or in
    flight for the same bytes before taking a Lens slot (lens/client.py)."""

    def test_cache_hit_and_inflight_join(self):
        import hashlib, tempfile
        from backend.lens import client
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
            f.write(JPEG)
            path = f.name
        key = hashlib.sha256(JPEG).hexdigest() + "|th"
        self.assertIsNone(client.shared_lens_data(path, "th"))  # nothing to share: caller uploads
        flight = client._Flight()
        with client._flights_lock:
            client._flights[key] = flight
        got = {}
        t = threading.Thread(target=lambda: got.update(v=client.shared_lens_data(path, "th")))
        t.start()
        time.sleep(0.1)
        self.assertTrue(t.is_alive())  # waits for the leader, holding no slot
        flight.data = {"originalParagraphs": ["x"]}
        flight.done.set()
        t.join(2)
        with client._flights_lock:
            client._flights.pop(key, None)
        self.assertEqual(got["v"], {"originalParagraphs": ["x"]})
        client._lens_cache_set(key, {"originalParagraphs": ["cached"]})
        try:
            self.assertEqual(client.shared_lens_data(path, "th"), {"originalParagraphs": ["cached"]})
        finally:
            with client._lens_cache_lock:
                client._lens_cache.pop(key, None)


class ProviderStatus(unittest.TestCase):
    def failure(self, status, message="provider said no"):
        from backend.ai.clients.provider_error import ProviderHttpError
        from backend.ai.failure_reason import provider_http_failure
        return provider_http_failure(
            ProviderHttpError(message, provider="openrouter", model="m", status=status))

    def test_402_is_billing_required(self):
        result = self.failure(402)
        self.assertEqual(result.code, "billing_required")
        self.assertFalse(result.retryable)

    def test_404_is_model_not_found(self):
        result = self.failure(404)
        self.assertEqual(result.code, "provider_model_not_found")
        self.assertIn("model not found or not available", result.message)
        self.assertFalse(result.retryable)

    def test_old_and_new_clients_map_the_codes(self):
        root = Path(__file__).resolve().parents[1]
        current = (root / "src/shared/error-contract.js").read_text(encoding="utf-8")
        self.assertIn('billing_required: "AI_BILLING_REQUIRED"', current)
        self.assertIn('provider_model_not_found: "AI_MODEL_NOT_FOUND"', current)

    def test_other_4xx_unchanged(self):
        self.assertEqual(self.failure(400).code, "provider_http")
        self.assertEqual(self.failure(401).code, "provider_auth_failed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
