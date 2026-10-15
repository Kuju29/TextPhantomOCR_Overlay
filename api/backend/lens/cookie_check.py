"""Check whether this machine can get a working Lens session by itself.

Run where the API runs (Hugging Face Space terminal, or the PC):

    python -m backend.lens.cookie_check

It visits https://lens.google.com/ like a browser's first visit (no Firebase, no
Raspberry Pi), then uploads one small generated test picture with that jar and
reports whether Google Lens accepted it. Cookie names are counted, values are
never printed. The default source (`direct-first`) uses this jar first. There
is no built-in Firebase jar: FAIL here means that machine needs your own jar
in `FIREBASE_URL` (then Firebase is the fallback; `TP_LENS_COOKIE_SOURCE=auto`
tries it first).
"""
from __future__ import annotations

import io
import json
import sys


def _test_image() -> bytes:
    from PIL import Image, ImageDraw
    image = Image.new("RGB", (640, 200), "white")
    draw = ImageDraw.Draw(image)
    draw.text((30, 80), "HELLO FROM TEXTPHANTOM LENS CHECK", fill="black")
    out = io.BytesIO()
    image.save(out, "JPEG", quality=90)
    return out.getvalue()


def main() -> int:
    from backend.lens import cookie, client
    try:
        jar = cookie._fetch_direct()
    except Exception as exc:  # noqa: BLE001 - report, do not crash
        print(json.dumps({"result": "FAIL", "step": "visit", "reason": str(exc)[:200]}))
        return 1
    report = {"step": "upload", "cookieCount": len(jar), "cookieNames": sorted(jar)[:20]}
    try:
        data = client._fetch_lens_once(_test_image(), "en", jar)
    except client.LensSessionError:
        print(json.dumps({**report, "result": "FAIL", "reason": "Lens did not accept this jar (no session in redirect)"}))
        return 1
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({**report, "result": "FAIL", "reason": f"{type(exc).__name__}: {str(exc)[:160]}"}))
        return 1
    text = client._has_lens_text(data) if isinstance(data, dict) else False
    print(json.dumps({**report, "result": "PASS" if text else "PASS_NO_TEXT",
                      "note": "Lens accepted the API's own jar" + ("" if text else "; no text was read from the test image")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
