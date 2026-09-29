"""A real HTTP 429 must preserve bounded provider cooldown without raw headers."""
import httpx
import sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from backend.ai.clients.provider_error import safe_http_error
from backend.ai.failure_reason import retry_after_sec, provider_http_failure
from backend.ai.transports.openai_compat import core

response = httpx.Response(429, json={"error":{"code":"rate_limit_exceeded",
    "message":"Token quota temporarily exceeded"}}, headers={"retry-after":"27",
    "x-ratelimit-remaining-tokens":"0"})
error = safe_http_error("AI", response, "openai/gpt-oss-20b")
assert error.status == 429
assert retry_after_sec(error) == 27.0
assert provider_http_failure(error).retry_after == 27
assert not hasattr(error, "headers")
assert "x-ratelimit" not in str(error)
invalid = httpx.Response(429, json={"error":"busy"}, headers={"retry-after":"999999999"})
assert retry_after_sec(safe_http_error("AI", invalid, "x")) == 3600.0
invalid_negative = httpx.Response(429, json={"error":"busy"}, headers={"retry-after":"-4"})
assert retry_after_sec(safe_http_error("AI", invalid_negative, "x")) == 0
class StreamClient:
    _textphantom_streaming = True
    def __init__(self, *args, **kwargs): pass
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def stream(self, method, url, **kwargs):
        class StreamContext:
            def __enter__(self):
                self.response = httpx.Response(429, json={"error":{"code":"rate_limit_exceeded",
                    "message":"TPM limit"}}, headers={"retry-after":"27"},
                    request=httpx.Request(method,url))
                return self.response
            def __exit__(self, *args): return False
        return StreamContext()

with patch.object(core.httpx, "Client", StreamClient):
    try:
        core.execute_openai_compatible_request(url="https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization":"Bearer placeholder"},payload={"model":"openai/gpt-oss-20b",
            "messages":[]},model="openai/gpt-oss-20b",provider_id="groq",timeout=2,
            timeout_policy="test")
    except Exception as exc:
        assert type(exc).__name__ == "ProviderHttpError", type(exc).__name__
        assert retry_after_sec(exc) == 27.0
        assert exc.provider_code == "rate_limit_exceeded"
    else:
        raise AssertionError("streamed provider 429 must fail with a structured cooldown")
print("PASS upstream Groq 429 Retry-After and bounded diagnostics")
