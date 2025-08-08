import os, json, time, hashlib, httpx, base64, re, asyncio, threading, shutil, logging
from typing import Dict, Any
from urllib.parse import urlparse

from seleniumbase import Driver

LOGGER = logging.getLogger("lens_images_core")
if not LOGGER.handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )

COOKIE_JSON_URL = os.getenv("COOKIE_JSON_URL", "")
UA = "Mozilla/5.0 (Lens OCR Images)"

_COMMON_CHROME_PATHS = [
    # Linux
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/opt/google/chrome/google-chrome",
    # macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    # Windows
    r"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    r"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
]

def _find_chrome_binary() -> str | None:
    env = os.getenv("CHROME_BINARY")
    if env and shutil.which(env):
        return env
    for p in _COMMON_CHROME_PATHS:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    try:
        import subprocess, shlex
        out = subprocess.check_output(shlex.split("which google-chrome"), stderr=subprocess.DEVNULL).decode().strip()
        if out:
            return out
    except Exception:
        pass
    return None

CHROME_EXTRA_ARGS = os.getenv(
    "CHROME_EXTRA_ARGS",
    "--disable-gpu --no-sandbox --disable-dev-shm-usage "
    "--window-size=1920,1080 --headless=new",
).split()

_cached_cookie_obj: Dict[str, Any] | None = None
_cached_cookie_fetched_at: float = 0.0
_CACHE_TTL = 300
_BROWSER_TTL = 900
_cookie_lock = threading.Lock()

_IDLE_TIMEOUT = int(os.getenv("CHROME_IDLE_SECONDS", "60"))
_driver_lock = threading.Lock()
_global_driver = None
_driver_last_use = 0.0

def _create_driver_for_cookies() -> Driver:
    bin_loc = _find_chrome_binary()
    LOGGER.info("▶️  starting headless Chrome for cookies (binary=%s)", bin_loc or "system default")
    drv = Driver(uc=True, headless=True, incognito=True, binary_location=bin_loc) if bin_loc else Driver(uc=True, headless=True, incognito=True)
    try:
        for flag in CHROME_EXTRA_ARGS:
            try:
                drv.driver.options.add_argument(flag)
            except Exception:
                pass
    except Exception:
        pass
    return drv

def _ensure_cookie_driver() -> Driver:
    global _global_driver, _driver_last_use
    with _driver_lock:
        if _global_driver is None:
            _global_driver = _create_driver_for_cookies()
        _driver_last_use = time.time()
        return _global_driver

def _quit_cookie_driver():
    global _global_driver
    try:
        if _global_driver:
            _global_driver.quit()
    except Exception:
        pass
    finally:
        _global_driver = None

def _driver_reaper_loop():
    global _driver_last_use
    while True:
        try:
            time.sleep(1)
            with _driver_lock:
                if _global_driver and (time.time() - _driver_last_use) > _IDLE_TIMEOUT:
                    LOGGER.info("♻️  quitting idle cookie driver")
                    _quit_cookie_driver()
        except Exception:
            pass

threading.Thread(target=_driver_reaper_loop, daemon=True).start()
def _grab_cookies_with_browser() -> Dict[str, Any]:
    drv = _ensure_cookie_driver()
    with _driver_lock:
        drv.get("https://lens.google.com/")
        jar = {c["name"]: c["value"] for c in drv.get_cookies() if c["domain"].endswith(".google.com")}
    return {"cookies": jar, "_source": "browser"}
async def _cookie_header() -> str:
    global _cached_cookie_obj, _cached_cookie_fetched_at
    now = time.time()

    def extract_obj(obj):
        if isinstance(obj, dict):
            return obj.get("cookies", obj)
        return obj

    with _cookie_lock:
        if _cached_cookie_obj:
            ttl = _BROWSER_TTL if _cached_cookie_obj.get("_source") == "browser" else _CACHE_TTL
            if (now - _cached_cookie_fetched_at) < ttl:
                return "; ".join(f"{k}={v}" for k, v in extract_obj(_cached_cookie_obj).items())

    if COOKIE_JSON_URL:
        try:
            async with httpx.AsyncClient(timeout=5) as cli:
                resp = await cli.get(COOKIE_JSON_URL)
                resp.raise_for_status()
                data = resp.json()
            with _cookie_lock:
                data["_source"] = "remote"
                _cached_cookie_obj, _cached_cookie_fetched_at = data, now
            return "; ".join(f"{k}={v}" for k, v in extract_obj(data).items())
        except Exception as e:
            LOGGER.warning("COOKIE_JSON_URL fetch failed: %s – falling back to headless chrome", e)

    loop = asyncio.get_running_loop()
    data: Dict[str, Any] = await loop.run_in_executor(None, _grab_cookies_with_browser)
    with _cookie_lock:
        _cached_cookie_obj, _cached_cookie_fetched_at = data, now
    return "; ".join(f"{k}={v}" for k, v in extract_obj(data).items())

def _sap_header(cookie_header: str) -> dict:
    origin = "https://lens.google.com"
    sid = None
    for c in cookie_header.split("; "):
        if c.startswith("__Secure-3PAPISID=") or c.startswith("SAPISID="):
            sid = c.split("=", 1)[1]
            break
    if not sid:
        return {}
    ts = int(time.time())
    raw = f"{ts} {sid} {origin}"
    sig = hashlib.sha1(raw.encode()).hexdigest()
    return {
        "X-Origin": origin,
        "X-Goog-AuthUser": "0",
        "Authorization": f"SAPISIDHASH {ts}_{sig}",
    }

def _json_url(loc: str, tl: str) -> str:
    from urllib.parse import urlparse, parse_qs

    q = parse_qs(urlparse(loc).query)
    return (
        "https://lens.google.com/translatedimage?"
        f"vsrid={q.get('vsrid', [None])[0]}&gsessionid={q.get('gsessionid', [None])[0]}"
        f"&sl=auto&tl={tl}&sf=1.07&ib=1"
    )

async def translate_lens(image_url: str, lang: str = "en") -> dict:
    start_ts = time.time()
    debug: Dict[str, Any] = {"steps": [], "errors": []}

    ck = await _cookie_header()
    hdr = {
        "User-Agent": UA,
        "Cookie": ck,
        "Referer": "https://lens.google.com/",
        **_sap_header(ck),
    }

    async with httpx.AsyncClient() as cli:
        try:
            o = urlparse(image_url)
            referer = f"{o.scheme}://{o.netloc}/" if o.scheme and o.netloc else None
            hdr_img = {"User-Agent": UA}
            if referer:
                hdr_img["Referer"] = referer
            img_resp = await cli.get(image_url, headers=hdr_img, timeout=10)
            img_resp.raise_for_status()
            debug["steps"].append(f"fetched original image {image_url} status={img_resp.status_code}")
        except httpx.HTTPStatusError as he:
            code = he.response.status_code if he.response is not None else "NA"
            debug["errors"].append(f"fetch image HTTP {code} {image_url}")
            raise RuntimeError(f"fetch image HTTP {code}")
        except httpx.TimeoutException:
            debug["errors"].append(f"fetch image TIMEOUT {image_url}")
            raise RuntimeError("fetch image TIMEOUT")
        except Exception as e:
            debug["errors"].append(f"fetch image ERROR {type(e).__name__} {image_url}")
            raise RuntimeError(f"fetch image ERROR {type(e).__name__}")

        files = {
            "encoded_image": ("file.jpg", img_resp.content, "image/jpeg"),
            "sbisrc": (None, "browser"),
            "rt": (None, "j"),
        }

        up = await cli.post(
            "https://lens.google.com/v3/upload",
            files=files,
            headers=hdr,
            follow_redirects=False,
            timeout=10,
        )
        debug["steps"].append(f"upload response status={up.status_code}")
        if up.status_code not in (302, 303):
            msg = f"Lens upload failed {up.status_code}"
            debug["errors"].append(msg)
            raise RuntimeError(msg)

        loc = up.headers.get("location", "")
        debug["steps"].append(f"got redirect location: {loc}")

        json_url = _json_url(loc, lang)
        debug["steps"].append(f"constructed json_url: {json_url}")

        js = await cli.get(json_url, headers=hdr, timeout=5)
        raw_body = js.text
        debug["steps"].append("fetched translation JSON")

        body = raw_body.lstrip(")]}'")
        try:
            info = json.loads(body)
        except Exception as e:
            debug["errors"].append(f"JSON parse failure: {e}; raw_body snippet: {body[:200]}")
            raise

        data_url = info.get("imageUrl", "")
        extracted_data_url = ""
        if data_url:
            if data_url.startswith("data:image/"):
                extracted_data_url = data_url
                debug["steps"].append("imageUrl already data URL")
            else:
                try:
                    html = base64.b64decode(data_url).decode("utf-8", errors="ignore")
                    m = re.search(r"data:image/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+", html)
                    if m:
                        extracted_data_url = m.group(0)
                        debug["steps"].append("extracted embedded data:image from base64 HTML")
                    else:
                        debug["steps"].append("no embedded data:image found inside decoded HTML")
                except Exception as e:
                    debug["errors"].append(f"error decoding imageUrl: {e}")

            if not extracted_data_url and (data_url.startswith("http://") or data_url.startswith("https://")):
                try:
                    fallback_img = await cli.get(data_url, headers={"User-Agent": UA}, timeout=5)
                    fallback_img.raise_for_status()
                    b64 = base64.b64encode(fallback_img.content).decode("utf-8")
                    extracted_data_url = f"data:image/jpeg;base64,{b64}"
                    debug["steps"].append("fetched fallback image URL and encoded to data URL")
                except Exception as e:
                    debug["errors"].append(f"fallback fetch of imageUrl failed: {e}")

        translated_text = info.get("translatedTextFull", "") or info.get("translatedText", "")

        duration = time.time() - start_ts
        debug["duration_sec"] = duration

        return {
            "image": extracted_data_url,
            "text": translated_text,
            "loc": loc,
            "json_url": json_url,
            "raw_info": info,
            "debug": debug,
        }
