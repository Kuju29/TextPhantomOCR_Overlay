"""Operator-owned Center target and bounded HTTP proxy for customer identity."""
from urllib.parse import urlsplit
import httpx
from backend.config import settings


def center_base_url():
    raw = str(settings.center_url or "").strip().rstrip("/")
    if not raw:
        return ""
    parsed = urlsplit(raw)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or
            parsed.password or parsed.query or parsed.fragment or
            parsed.path not in {"", "/"}):
        raise RuntimeError("TP_CENTER_URL must be a plain Center origin without a path")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise RuntimeError("Remote TP_CENTER_URL requires HTTPS")
    return raw


def center_origin():
    url = urlsplit(center_base_url())
    return f"{url.scheme}://{url.netloc}"


def require_center():
    value = center_base_url()
    if not value:
        raise RuntimeError("Paid is not configured on this API")
    return value


async def customer_request(path, *, method="GET", body=None, bearer=""):
    base = require_center()
    headers = {"Accept": "application/json"}
    if method != "GET":
        headers.update({"Origin": center_origin(), "Content-Type": "application/json"})
    if bearer:
        headers["Authorization"] = "Bearer " + bearer
    async with httpx.AsyncClient(timeout=httpx.Timeout(15, connect=4), follow_redirects=False,
                                 trust_env=False) as client:
        response = await client.request(method, base + path, headers=headers, json=body)
    try:
        payload = response.json()
    except ValueError:
        payload = {"error": {"code": "CENTER_RESPONSE_INVALID", "message": "Center ตอบไม่ถูกต้อง"}}
    return response.status_code, payload
