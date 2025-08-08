import os, time, asyncio, base64, re, threading, hashlib, logging, shutil
from io import BytesIO
from typing import Any, Dict, List, Union
from urllib.parse import urlparse

import httpx
from PIL import Image
from seleniumbase import Driver
from selenium.common.exceptions import WebDriverException

import platform as _platform
from pathlib import Path as _Path

CHROME_BINARY_PATH = os.getenv("CHROME_BINARY_PATH", "").strip() 

def _possible_chrome_paths() -> list:
    paths = []
    if CHROME_BINARY_PATH:
        paths.append(CHROME_BINARY_PATH)

    here = _Path(__file__).resolve().parent
    rels = [
        "chrome-linux64/chrome",
        "chrome-linux/chrome",
        "chromium-linux64/chrome",
        "chrome-win64/chrome.exe",
        "chrome-win/chrome.exe",
        "Chromium/chrome.exe",
        "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac/Google Chrome.app/Contents/MacOS/Google Chrome",
        "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    for r in rels:
        p = here / r
        paths.append(str(p))

    sysname = _platform.system().lower()
    if "windows" in sysname:
        userp = os.environ.get("LOCALAPPDATA", "")
        progf = os.environ.get("PROGRAMFILES", r"C:\Program Files")
        progx = os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")
        candidates = [
            rf"{progf}\Google\Chrome\Application\chrome.exe",
            rf"{progx}\Google\Chrome\Application\chrome.exe",
            rf"{userp}\Google\Chrome\Application\chrome.exe",
            rf"{progf}\Chromium\Application\chrome.exe",
            rf"{progx}\Chromium\Application\chrome.exe",
        ]
        # WSL mounts
        candidates += [
            "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
            "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        ]
        paths += candidates
    elif "darwin" in sysname or "mac" in sysname:
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            str(_Path.home() / "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
        paths += candidates
    else:
        # Linux
        candidates = [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
            "/snap/bin/chromium",
            "/app/bin/chrome",
            "/opt/google/chrome/chrome",
            "/usr/local/bin/google-chrome",
            "/usr/local/bin/chromium",
        ]
        paths += candidates

    try:
        paths += list(_COMMON_CHROME_PATHS)
    except Exception:
        pass

    seen = set()
    uniq = []
    for p in paths:
        if p and p not in seen:
            seen.add(p); uniq.append(p)
    return uniq

LOGGER = logging.getLogger("lens_text_core")
if not LOGGER.handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )

COOKIE_JSON_URL = os.getenv("COOKIE_JSON_URL", "")
UA = "Mozilla/5.0 (Lens Text OCR)"

CHROME_EXTRA_ARGS = os.getenv(
    "CHROME_EXTRA_ARGS",
    "--disable-gpu --no-sandbox --disable-dev-shm-usage "
    "--window-size=1920,1080 --headless=new",
).split()

_CACHE_TTL    = 300  
_IDLE_TIMEOUT = int(os.getenv("CHROME_IDLE_SECONDS", "60"))
_BROWSER_TTL  = 900  

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

def _find_chrome_binary() -> str:
    if (env := os.getenv("CHROME_BINARY")):
        return env

    for cmd in ("google-chrome", "chromium-browser", "chromium", "chrome"):
        path = shutil.which(cmd)
        if path:
            return path

    for path in _COMMON_CHROME_PATHS:
        if os.path.exists(path):
            return path

    raise RuntimeError(
        "Chrome binary not found; set CHROME_BINARY env var or install Chrome/Chromium"
    )

_cached_cookie, _cached_cookie_ts, _cookie_lock = None, 0.0, threading.Lock()
_global_driver, _driver_last_use, _driver_lock  = None, 0.0, threading.Lock()

def _grab_cookies_with_browser() -> Dict[str, Any]:
    drv = Driver(uc=True, headless=True, incognito=True,
                 binary_location=str(_find_chrome_binary()))
    try:
        drv.get("https://lens.google.com/")
        jar = {
            c["name"]: c["value"]
            for c in drv.get_cookies()
            if c["domain"].endswith(".google.com")
        }
        return {"cookies": jar, "_source": "browser"}
    finally:
        try:
            drv.quit()
        except Exception:
            pass

async def _cookie_header() -> str:
    global _cached_cookie, _cached_cookie_ts
    now = time.time()

    with _cookie_lock:
        if _cached_cookie:
            ttl = _BROWSER_TTL if _cached_cookie.get("_source") == "browser" else _CACHE_TTL
            if (now - _cached_cookie_ts) < ttl:
                obj = _cached_cookie.get("cookies", _cached_cookie)
                return "; ".join(f"{k}={v}" for k, v in obj.items())

    if COOKIE_JSON_URL:
        try:
            async with httpx.AsyncClient(timeout=4) as cli:
                resp = await cli.get(COOKIE_JSON_URL)
                resp.raise_for_status()
                data = resp.json()
            with _cookie_lock:
                data["_source"] = "remote"
                _cached_cookie, _cached_cookie_ts = data, now
            obj = data.get("cookies", data)
            return "; ".join(f"{k}={v}" for k, v in obj.items())
        except Exception as e:
            LOGGER.warning("fetch COOKIE_JSON_URL failed: %s – fallback to browser", e)

    loop = asyncio.get_running_loop()
    data = await loop.run_in_executor(None, _grab_cookies_with_browser)

    with _cookie_lock:
        _cached_cookie, _cached_cookie_ts = data, now

    obj = data.get("cookies", data)
    return "; ".join(f"{k}={v}" for k, v in obj.items())

def _sap_header(cookie_hdr: str) -> Dict[str, str]:
    origin = "https://lens.google.com"
    sid = None
    for part in cookie_hdr.split("; "):
        if part.startswith("__Secure-3PAPISID=") or part.startswith("SAPISID="):
            sid = part.split("=", 1)[1]
            break
    if not sid:
        return {}
    ts  = int(time.time())
    sig = hashlib.sha1(f"{ts} {sid} {origin}".encode()).hexdigest()
    return {
        "X-Origin": origin,
        "X-Goog-AuthUser": "0",
        "Authorization": f"SAPISIDHASH {ts}_{sig}",
    }


def _create_driver(cookie_dict: Dict[str, str]) -> Driver:
    LOGGER.info("▶️  starting headless Chrome")
    drv = None

    for cand in _possible_chrome_paths():
        try:
            if cand and os.path.exists(cand):
                LOGGER.info("Trying Chrome at: %s", cand)
                drv = Driver(uc=True, headless=True, incognito=True, binary_location=str(cand))
                break
        except Exception as e:
            try:
                drv.quit()
            except Exception:
                pass
            drv = None

    if drv is None:
        try:
            drv = Driver(uc=True, headless=True, incognito=True)
        except Exception as e:
            last_err = e
            raise

    try:
        for flag in CHROME_EXTRA_ARGS:
            drv.driver.options.add_argument(flag)
    except Exception:
        LOGGER.debug("could not append extra chrome args")

    drv.execute_cdp_cmd("Network.enable", {})
    for name, val in cookie_dict.items():
        drv.execute_cdp_cmd("Network.setCookie", {
            "name": name, "value": val,
            "domain": ".google.com", "path": "/", "secure": True
        })
    return drv

def _is_alive(drv: Driver) -> bool:
    try: _ = drv.title; return True
    except Exception:   return False

def _ensure_driver(cookie_dict: Dict[str, str]) -> Driver:
    global _global_driver, _driver_last_use
    with _driver_lock:
        if _global_driver is None or not _is_alive(_global_driver):
            try:
                if _global_driver: _global_driver.quit()
            except Exception: pass
            _global_driver = _create_driver(cookie_dict)
        _driver_last_use = time.time()
        return _global_driver

def _driver_reaper():
    global _global_driver
    while True:
        time.sleep(1)
        if _global_driver and (time.time() - _driver_last_use) > _IDLE_TIMEOUT:
            LOGGER.info("♻️  quitting idle driver")
            try: _global_driver.quit()
            except Exception: pass
            _global_driver = None

threading.Thread(target=_driver_reaper, daemon=True).start()

def _parse_calc_value(calc: str, dim: float) -> float:
    m = re.search(r"calc\(([\d.]+)%\s*([+-])\s*([\d.]+)px\)", calc)
    if not m: return 0.0
    pct, op, off = float(m[1]), m[2], float(m[3])
    base = dim * pct / 100.0
    return base - off if op == "-" else base + off

def _extract_boxes(drv: Driver, w: int, h: int) -> List[Dict[str, Any]]:
    drv.wait_for_element_visible("div.lv6PAb", timeout=10)
    nodes = drv.find_elements(
        "xpath",
        "//div[contains(@class,'lv6PAb') and @aria-label]"
    )

    out: List[Dict[str,Any]] = []
    for n in nodes:
        if not (n.get_attribute("data-line-index") or "").strip():
            continue

        text  = (n.get_attribute("aria-label") or "").strip()
        style = n.get_attribute("style") or ""
        if not text or "calc(" not in style:
            continue

        kv = {k.strip(): v.strip()
              for k,v in (p.split(":",1) for p in style.split(";") if ":" in p)}

        top, left = _parse_calc_value(kv.get("top",""),   h), _parse_calc_value(kv.get("left",""),  w)
        wid, hei  = _parse_calc_value(kv.get("width",""), w), _parse_calc_value(kv.get("height",""),h)
        rot_m = re.search(r"rotate\(([-\d.]+)deg\)", style); rot = float(rot_m[1]) if rot_m else 0.0

        verts = [
            {"x": int(left),        "y": int(top)},
            {"x": int(left+wid),    "y": int(top)},
            {"x": int(left+wid),    "y": int(top+hei)},
            {"x": int(left),        "y": int(top+hei)},
        ]
        abs_style = f"top: {int(top)}px; left: {int(left)}px; width: {int(wid)}px; height: {int(hei)}px; transform: rotate({rot}deg);"

        out.append({
            "description": text,
            "boundingPoly": {"vertices": verts},
            "rotate": rot,
            "style": abs_style,

            "raw_style": style,
            "top_str": kv.get("top",""),
            "left_str": kv.get("left",""),
            "width_str": kv.get("width",""),
            "height_str": kv.get("height",""),
        })
    return out

def _merge_by_center_line(anns: List[Dict[str,Any]], m_x: int=10, m_y: int=15) -> List[Dict[str,Any]]:
    for a in anns:
        v  = a["boundingPoly"]["vertices"]
        xs, ys = [p["x"] for p in v], [p["y"] for p in v]
        a["_l"], a["_r"], a["_t"], a["_b"] = min(xs), max(xs), min(ys), max(ys)
        a["_cx"], a["_cy"] = (a["_l"]+a["_r"])/2, (a["_t"]+a["_b"])/2

    parent = list(range(len(anns)))
    def find(i):
        while parent[i]!=i:
            parent[i]=parent[parent[i]]
            i=parent[i]
        return i
    def union(i,j):
        ri,rj = find(i),find(j)
        if ri!=rj: parent[rj]=ri

    for i in range(len(anns)):
        for j in range(i+1,len(anns)):
            ai, aj = anns[i], anns[j]
            if (abs(ai["_cx"]-aj["_cx"]) < m_x and
                ai["_t"]-m_y < aj["_b"] and ai["_b"]+m_y > aj["_t"]):
                union(i,j)

    groups: Dict[int,List[Dict[str,Any]]] = {}
    for idx,a in enumerate(anns):
        groups.setdefault(find(idx), []).append(a)

    merged: List[Dict[str,Any]] = []
    for g in groups.values():
        if len(g)==1:
            a = g[0]
            merged.append({
                "description": a["description"],
                "boundingPoly": a["boundingPoly"],
                "rotate": a["rotate"],
                "style": a["style"],
            })
        else:
            txt = "\n".join(aa["description"] for aa in g)
            l,r = min(aa["_l"] for aa in g), max(aa["_r"] for aa in g)
            t,b = min(aa["_t"] for aa in g), max(aa["_b"] for aa in g)
            merged.append({
                "description": txt,
                "boundingPoly": {"vertices":[
                    {"x":l,"y":t}, {"x":r,"y":t}, {"x":r,"y":b}, {"x":l,"y":b}]},
                "rotate": 0.0,
                "style": f"top: {t}px; left: {l}px; width: {r-l}px; height: {b-t}px; transform: rotate(0deg);",
            })
    return merged

async def translate_lens_text(src: Union[str, bytes, BytesIO]) -> Dict[str,Any]:
    if isinstance(src, (bytes,bytearray)):           img_bytes = bytes(src)
    elif isinstance(src, BytesIO):                   img_bytes = src.getvalue()
    elif isinstance(src, str):
        if src.startswith("data:"):                  img_bytes = base64.b64decode(src.split(",",1)[1])
        else:
            async with httpx.AsyncClient() as cli:
                o = urlparse(src)
                referer = f"{o.scheme}://{o.netloc}/" if o.scheme and o.netloc else None
                hdr_img = {"User-Agent": UA}
                if referer: hdr_img["Referer"] = referer
                try:
                    r = await cli.get(src, headers=hdr_img, timeout=10)
                    r.raise_for_status()
                    img_bytes = r.content
                except httpx.HTTPStatusError as he:
                    code = he.response.status_code if he.response is not None else "NA"
                    raise RuntimeError(f"fetch image HTTP {code}")
                except httpx.TimeoutException:
                    raise RuntimeError("fetch image TIMEOUT")
                except Exception as e:
                    raise RuntimeError(f"fetch image ERROR {type(e).__name__}")
    else: raise TypeError("unsupported src type")

    with Image.open(BytesIO(img_bytes)) as im:
        w, h = im.size

    ck = await _cookie_header()
    hdr = {"User-Agent": UA, "Cookie": ck, "Referer":"https://lens.google.com/", **_sap_header(ck)}
    async with httpx.AsyncClient(follow_redirects=False) as cli:
        up = await cli.post("https://lens.google.com/v3/upload",
                            files={ "encoded_image": ("file.jpg", img_bytes, "image/jpeg"),
                                    "sbisrc":(None,"browser"), "rt":(None,"j") },
                            headers=hdr, timeout=10)
    if up.status_code not in (302,303):
        raise RuntimeError(f"Lens upload failed: {up.status_code}")
    loc = up.headers.get("location") or ""
    if not loc: raise RuntimeError("no redirect location")

    cookie_dict = {k: v for k, v in (p.split("=", 1) for p in ck.split("; "))}
    drv = _ensure_driver(cookie_dict)

    def _blocking() -> List[Dict[str, Any]]:
        nonlocal drv
        with _driver_lock:
            try:
                try:
                    drv.get(loc)
                except WebDriverException:
                    try:
                        drv.quit()
                    except Exception:
                        pass
                    drv = _ensure_driver(cookie_dict)
                    drv.get(loc)
                return _extract_boxes(drv, w, h)
            finally:
                pass

    loop = asyncio.get_running_loop()
    raw = await loop.run_in_executor(None, _blocking)

    merged  = _merge_by_center_line(raw)
    fulltxt = " ".join(a["description"] for a in raw).strip()

    return {
        "textAnnotations":      merged,
        "rawTextAnnotations":   raw,
        "fullTextAnnotation":   {"text": fulltxt},
        "loc":                  loc,
    }

async def prewarm_driver():
    """Warm up a Chrome session early to reduce cold-start latency."""
    try:
        cookie_hdr = await _cookie_header()
        cookie_dict = {k: v for k, v in (p.split("=", 1) for p in cookie_hdr.split("; ") if "=" in p)}
        _ensure_driver(cookie_dict)
        LOGGER.info("prewarm_driver: driver is ready")
    except Exception as e:
        LOGGER.warning("prewarm_driver failed: %s", e)
