import asyncio, base64, copy, hashlib, io, json, os, re, tempfile, time, uuid, httpx

from backend import lens_core as core

from collections import OrderedDict
from threading import Lock

from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

SERVER_MAX_WORKERS = int(os.environ.get('SERVER_MAX_WORKERS', '15'))
JOB_TTL_SEC = int(os.environ.get('JOB_TTL_SEC', '3600'))
HTTP_TIMEOUT_SEC = float(os.environ.get('HTTP_TIMEOUT_SEC', str(getattr(core, 'AI_TIMEOUT_SEC', 120))))
SUPPORTED_MODES = {"lens_images", "lens_text"}
BUILD_ID = os.environ.get('TP_BUILD_ID', 'v9-backendfix-20260129')
TP_DEBUG = str(os.environ.get('TP_DEBUG', '')).strip().lower() in ('1', 'true', 'yes', 'on')

TP_PARA_MARKER_PREFIX = '<<TP_P'
TP_PARA_MARKER_SUFFIX = '>>'

TP_RESULT_CACHE_MAX = int(os.environ.get('TP_RESULT_CACHE_MAX', '24'))
TP_AI_RESULT_CACHE_MAX = int(os.environ.get('TP_AI_RESULT_CACHE_MAX', '16'))
TP_WARMUP_LANG = (os.environ.get('TP_WARMUP_LANG', 'th') or 'th').strip()

_result_cache: OrderedDict[str, Dict[str, Any]] = OrderedDict()
_ai_result_cache: OrderedDict[str, Dict[str, Any]] = OrderedDict()
_jobs: Dict[str, Dict[str, Any]] = {}
_job_queue: asyncio.Queue = asyncio.Queue()
_result_cache_lock = Lock()
_ai_cache_lock = Lock()

def _dbg(tag: str, data=None) -> None:
    if not TP_DEBUG:
        return
    try:
        if data is None:
            print(f'[TextPhantom][dbg] {tag}')
        else:
            s = json.dumps(data, ensure_ascii=False)
            if len(s) > 2000:
                s = s[:2000] + '…'
            print(f'[TextPhantom][dbg] {tag} {s}')
    except Exception:
        try:
            print(f'[TextPhantom][dbg] {tag} {data}')
        except Exception:
            pass

def _tree_stats(tree) -> dict:
    if not isinstance(tree, dict):
        return {'paras': 0, 'items': 0, 'spans': 0}
    paras = tree.get('paragraphs') or []
    if not isinstance(paras, list):
        return {'paras': 0, 'items': 0, 'spans': 0}
    items = 0
    spans = 0
    for p in paras:
        if not isinstance(p, dict):
            continue
        its = p.get('items') or []
        if not isinstance(its, list):
            continue
        items += len(its)
        for it in its:
            if not isinstance(it, dict):
                continue
            sp = it.get('spans') or []
            if isinstance(sp, list):
                spans += len(sp)
    return {'paras': len(paras), 'items': items, 'spans': spans}

def _tree_to_paragraph_texts(tree: Any) -> List[str]:
    if not isinstance(tree, dict):
        return []
    paras = tree.get('paragraphs') or []
    if not isinstance(paras, list) or not paras:
        return []
    out: List[str] = []
    for p in paras:
        if not isinstance(p, dict):
            out.append('')
            continue
        t = str(p.get('text') or '').strip()
        if not t:
            items = p.get('items') or []
            if isinstance(items, list) and items:
                t = ' '.join(str(it.get('text') or '').strip() for it in items if isinstance(
                    it, dict) and str(it.get('text') or '').strip())
        out.append(t)
    return out

def _apply_para_markers(paras: List[str]) -> str:
    if not paras:
        return ''
    parts: List[str] = []
    for i, t in enumerate(paras):
        parts.append(
            f"{TP_PARA_MARKER_PREFIX}{i}{TP_PARA_MARKER_SUFFIX}\n{(t or '').strip()}")
    return '\n\n'.join(parts)

def _clamp_runaway_repeats(s: str, max_repeat: int = 12) -> str:
    if not s:
        return ''
    pat = re.compile(r"(.)\1{" + str(max_repeat) + r",}")
    return pat.sub(lambda m: m.group(1) * max_repeat, s)

def _extract_marker_indices(s: str) -> set[int]:
    if not s:
        return set()
    out: set[int] = set()
    for m in re.finditer(r"<<TP_P(\d+)>>", s):
        try:
            out.add(int(m.group(1)))
        except Exception:
            continue
    return out

def _needs_ai_retry(ai_text_full: str, expected_paras: int) -> bool:
    if expected_paras <= 0:
        return False
    idx = _extract_marker_indices(ai_text_full)
    if len(idx) >= expected_paras:
        return False
    
    if (TP_PARA_MARKER_PREFIX in (ai_text_full or '')) and (TP_PARA_MARKER_SUFFIX not in (ai_text_full or '')):
        return True
    return True

def _now() -> float:
    return time.time()

def _lru_get(cache: OrderedDict, lock: Lock, key: str) -> Optional[Dict[str, Any]]:
    if not key:
        return None
    with lock:
        v = cache.get(key)
        if v is None:
            return None
        cache.move_to_end(key)
        return copy.deepcopy(v)

def _lru_set(cache: OrderedDict, lock: Lock, key: str, value: Dict[str, Any], max_items: int) -> None:
    if not key or not isinstance(value, dict) or max_items <= 0:
        return
    with lock:
        cache[key] = copy.deepcopy(value)
        cache.move_to_end(key)
        while len(cache) > max_items:
            cache.popitem(last=False)

def _sha256_hex(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest() if blob else ''

def _ai_prompt_sig(s: str) -> str:
    t = (s or '').strip()
    if not t:
        return ''
    return hashlib.sha256(t.encode('utf-8')).hexdigest()[:12]

def _build_cache_key(img_hash: str, lang: str, mode: str, source: str, ai_cfg: Optional["AiConfig"]) -> str:
    parts = [img_hash, _normalize_lang(lang), (mode or '').strip(), (source or '').strip()]
    if ai_cfg and (source or '').strip().lower() == 'ai':
        parts.extend([
            (ai_cfg.provider or '').strip(),
            (ai_cfg.model or '').strip(),
            (ai_cfg.base_url or '').strip(),
            _ai_prompt_sig(ai_cfg.prompt_editable),
        ])
    return '|'.join([p for p in parts if p is not None])


def _b64_to_bytes(b64: str) -> bytes:
    pad = '=' * ((4 - (len(b64) % 4)) % 4)
    return base64.b64decode(b64 + pad)

def _datauri_to_bytes(data_uri: str) -> tuple[bytes, str]:
    s = (data_uri or '').strip()
    if not s.startswith('data:'):
        return b'', ''
    head, _, b64 = s.partition(',')
    mime = ''
    if ';' in head:
        mime = head[5:head.index(';')]
    return _b64_to_bytes(b64), mime or 'application/octet-stream'

def _bytes_to_datauri(blob: bytes, mime: str) -> str:
    b64 = base64.b64encode(blob).decode('ascii')
    return f"data:{mime};base64,{b64}"

def _download_bytes(url: str) -> tuple[bytes, str]:
    u = (url or '').strip()
    if not u:
        return b'', ''
    with httpx.Client(timeout=HTTP_TIMEOUT_SEC, follow_redirects=True) as client:
        r = client.get(u)
        r.raise_for_status()
        ct = (r.headers.get('content-type') or '').split(';')[0].strip()
        return r.content, ct

def _detect_provider_from_key(api_key: str) -> str:
    return core._canonical_provider(core._detect_ai_provider_from_key(api_key))

def _resolve_provider_defaults(provider: str) -> dict:
    return (getattr(core, 'AI_PROVIDER_DEFAULTS', {}) or {}).get(provider, {})

def _resolve_model(provider: str, model: str) -> str:
    return core._resolve_model(provider, model)

def _normalize_lang(lang: str) -> str:
    return core._normalize_lang(lang)

@dataclass
class AiConfig:
    api_key: str
    model: str = 'auto'
    provider: str = 'auto'
    base_url: str = 'auto'
    prompt_editable: str = ''

def _collapse_ws(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()

def _sanitize_marked_text(marked_text: str) -> str:
    t = str(marked_text or "")
    if not t:
        return ""
    indices = _extract_marker_indices(t)
    if not indices:
        return _collapse_ws(t)
    out_lines: List[str] = []
    for idx in indices:
        marker = f"<<TP_P{idx}>>"
        m = re.search(
            rf"{re.escape(marker)}\s*([\s\S]*?)(?=<<TP_P\d+>>|\Z)", t)
        seg = m.group(1) if m else ""
        seg = _collapse_ws(seg)
        out_lines.append(marker)
        out_lines.append(seg)
        out_lines.append("")
    return "\n".join(out_lines).strip("\n")

def _build_ai_prompt_packet_custom(target_lang: str, original_text_full: str, prompt_editable: str, is_retry: bool = False) -> tuple[str, List[str]]:
    lang = _normalize_lang(target_lang)
    style_prompt = (prompt_editable or "").strip()
    if not style_prompt:
        style_prompt = (getattr(core, "ai_prompt_user_default",
                        lambda _l: "")(lang) or "").strip()

    input_json = json.dumps(
        {"target_lang": lang, "stylePrompt": style_prompt,
            "originalTextFull": str(original_text_full or "")},
        ensure_ascii=False,
    )

    system_parts: List[str] = [
        "SYSTEM: You translate manga dialogue.",
        "Task: Translate originalTextFull into target_lang. Apply stylePrompt.",
        "Markers: Keep every paragraph marker like <<TP_P0>> unchanged and in order. Do not remove or add markers.",
        "Output: Return ONLY JSON (no markdown, no extra text).",
        "OUTPUT_JSON schema: {\"aiTextFull\":\"...\"}",
        "aiTextFull must include all the same markers, each followed by that paragraph's translated text.",
        "Keep text concise for speech bubbles. Avoid long repeated characters (max 12).",
    ]
    if is_retry:
        system_parts.append(
            "Retry: Your previous output may have been truncated. You MUST output ALL markers from the first to the last marker in the input."
        )
    system_text = "\n".join([p for p in system_parts if p])

    user_text = (
        "INPUT_JSON (json):\n```json\n"
        + input_json
        + "\n```\n\nOUTPUT_JSON (json):\n```json\n{\"aiTextFull\":\"...\"}\n```"
    )

    return system_text, [user_text]

def ai_translate_text(original_text_full: str, target_lang: str, ai: AiConfig, is_retry: bool = False) -> dict:
    api_key = (ai.api_key or '').strip()
    if not api_key:
        raise Exception('AI api_key is required')

    provider = core._canonical_provider((ai.provider or 'auto'))
    if provider in ('', 'auto'):
        provider = _detect_provider_from_key(api_key)

    preset = _resolve_provider_defaults(provider) or {}

    model = _resolve_model(provider, (ai.model or 'auto'))

    base_url = (ai.base_url or 'auto').strip()
    if base_url in ('', 'auto'):
        base_url = (preset.get('base_url') or '').strip()

    if provider not in ('gemini', 'anthropic'):
        if not base_url:
            base_url = (_resolve_provider_defaults('openai') or {}).get(
                'base_url') or 'https://api.openai.com/v1'

    system_text, user_parts = _build_ai_prompt_packet_custom(
        target_lang, original_text_full, ai.prompt_editable, is_retry=is_retry)

    started = _now()
    used_model = model
    if provider == 'gemini':
        raw = core._gemini_generate_json(
            api_key, model, system_text, user_parts)
    elif provider == 'anthropic':
        raw = core._anthropic_generate_json(
            api_key, model, system_text, user_parts)
    else:
        raw, used_model = core._openai_compat_generate_json(
            api_key, base_url, model, system_text, user_parts)

    ai_text_full = core._parse_ai_textfull_only(
        raw) if core.DO_AI_JSON else core._parse_ai_textfull_text_only(raw)

    ai_text_full = _sanitize_marked_text(ai_text_full)

    return {
        'aiTextFull': ai_text_full,
        'meta': {
            'model': used_model,
            'provider': provider,
            'base_url': base_url,
            'latency_sec': round(_now() - started, 3),
        },
    }

def process_image_path(image_path: str, lang: str, mode: str, ai_cfg: Optional[AiConfig]) -> dict:
    mode_id = (mode or '').strip()
    if mode_id not in SUPPORTED_MODES:
        mode_id = 'lens_images'

    target_lang = _normalize_lang(lang)

    data = core.get_lens_data_from_image(
        image_path, getattr(core, 'FIREBASE_URL', ''), target_lang)
    img = core.Image.open(image_path).convert('RGB')
    W, H = img.size

    thai_font = getattr(core, 'FONT_THAI_PATH', 'NotoSansThai-Regular.ttf')
    latin_font = getattr(core, 'FONT_LATIN_PATH', 'NotoSans-Regular.ttf')

    if target_lang == 'ja':
        latin_font = getattr(core, 'FONT_JA_PATH', latin_font)
    elif target_lang in ('zh', 'zh-hans', 'zh_cn', 'zh-cn', 'zh_hans'):
        latin_font = getattr(core, 'FONT_ZH_SC_PATH', latin_font)
    elif target_lang in ('zh-hant', 'zh_tw', 'zh-tw', 'zh_hant'):
        latin_font = getattr(core, 'FONT_ZH_TC_PATH', latin_font)

    if getattr(core, 'FONT_DOWNLOD', True):
        thai_font = core.ensure_font(
            thai_font, getattr(core, 'FONT_THAI_URLS', []))
        if target_lang == 'ja':
            latin_font = core.ensure_font(
                latin_font, getattr(core, 'FONT_JA_URLS', []))
        elif target_lang in ('zh', 'zh-hans', 'zh_cn', 'zh-cn', 'zh_hans'):
            latin_font = core.ensure_font(
                latin_font, getattr(core, 'FONT_ZH_SC_URLS', []))
        elif target_lang in ('zh-hant', 'zh_tw', 'zh-tw', 'zh_hant'):
            latin_font = core.ensure_font(
                latin_font, getattr(core, 'FONT_ZH_TC_URLS', []))
        else:
            latin_font = core.ensure_font(
                latin_font, getattr(core, 'FONT_LATIN_URLS', []))

    image_url = data.get('imageUrl') if isinstance(data, dict) else None

    out: Dict[str, Any] = {
        'mode': mode_id,
        'imageUrl': image_url,
        'imageDataUri': '',
        'originalContentLanguage': data.get('originalContentLanguage') if isinstance(data, dict) else None,
        'originalTextFull': data.get('originalTextFull') if isinstance(data, dict) else None,
        'translatedTextFull': data.get('translatedTextFull') if isinstance(data, dict) else None,
        'AiTextFull': '',
        'originalParagraphs': (data.get('originalParagraphs') or []) if isinstance(data, dict) else [],
        'translatedParagraphs': (data.get('translatedParagraphs') or []) if isinstance(data, dict) else [],
        'original': {},
        'translated': {},
        'Ai': {},
    }

    if mode_id == 'lens_images':
        if image_url:
            decoded = core.decode_imageurl_to_datauri(str(image_url))
            if decoded:
                out['imageDataUri'] = decoded
            elif isinstance(image_url, str) and image_url.startswith(('http://', 'https://')):
                blob, mime2 = _download_bytes(image_url)
                out['imageDataUri'] = _bytes_to_datauri(
                    blob, mime2 or 'image/jpeg')

        if not out.get('imageDataUri'):
            with open(image_path, 'rb') as f:
                blob = f.read()
            out['imageDataUri'] = _bytes_to_datauri(blob, 'image/jpeg')
        return out

    original_span_tokens = None
    original_tree = None
    translated_tree = None

    def _base_img_for_overlay() -> core.Image.Image:
        if not (getattr(core, 'ERASE_OLD_TEXT_WITH_ORIGINAL_BOXES', True) and original_span_tokens):
            return img
        return core.erase_text_with_boxes(
            img,
            original_span_tokens,
            pad_px=getattr(core, 'ERASE_PADDING_PX', 2),
            sample_margin_px=getattr(core, 'ERASE_SAMPLE_MARGIN_PX', 6),
        )

    if getattr(core, 'DO_ORIGINAL', True):
        tree, _ = core.decode_tree(
            out.get('originalParagraphs') or [],
            out.get('originalTextFull') or '',
            'original',
            W,
            H,
            want_raw=False,
        )
        original_tree = tree
        original_span_tokens = core.flatten_tree_spans(tree)
        _dbg('tree.original', _tree_stats(original_tree))
        out['original'] = {
            'originalTree': tree,
            'originalTextFull': out.get('originalTextFull') or '',
        }

    if getattr(core, 'DO_TRANSLATED', True):
        tree, _ = core.decode_tree(
            out.get('translatedParagraphs') or [],
            out.get('translatedTextFull') or '',
            'translated',
            W,
            H,
            want_raw=False,
        )
        translated_tree = tree
        translated_span_tokens = core.flatten_tree_spans(tree)
        _dbg('tree.translated', _tree_stats(translated_tree))
        out['translated'] = {
            'translatedTree': tree,
            'translatedTextFull': out.get('translatedTextFull') or '',
        }

    def _tree_score(tree: Any) -> int:
        if not isinstance(tree, dict):
            return -1
        paragraphs = tree.get('paragraphs') or []
        if not isinstance(paragraphs, list) or not paragraphs:
            return -1

        para_count = len(paragraphs)
        item_count = 0
        span_count = 0
        for p in paragraphs:
            if not isinstance(p, dict):
                continue
            items = p.get('items') or []
            if not isinstance(items, list):
                continue
            item_count += len(items)
            for it in items:
                if not isinstance(it, dict):
                    continue
                spans = it.get('spans') or []
                if isinstance(spans, list):
                    span_count += len(spans)

        return item_count * 10000 + para_count * 100 + span_count

    def _pick_ai_template_tree() -> Optional[Dict[str, Any]]:
        tr_score = _tree_score(translated_tree)
        og_score = _tree_score(original_tree)

        if tr_score < 0 and og_score < 0:
            return None
        if og_score > tr_score:
            return original_tree
        return translated_tree or original_tree

    ai_tree = None
    if ai_cfg and (ai_cfg.api_key or '').strip() and getattr(core, 'DO_AI', True):
        src_paras = _tree_to_paragraph_texts(original_tree or {})
        src_text = _apply_para_markers(src_paras) if src_paras else str(
            out.get('originalTextFull') or '')
        ai = ai_translate_text(src_text, target_lang, ai_cfg)
        if src_paras and _needs_ai_retry(str(ai.get('aiTextFull') or ''), len(src_paras)):
            _dbg('ai.retry', {
                'expected_paras': len(src_paras),
                'found_markers': len(_extract_marker_indices(str(ai.get('aiTextFull') or ''))),
            })
            retry_paras = [_clamp_runaway_repeats(p) for p in src_paras]
            retry_text = _apply_para_markers(retry_paras) or src_text
            ai = ai_translate_text(
                retry_text, target_lang, ai_cfg, is_retry=True)

        template_tree = _pick_ai_template_tree()
        _dbg('ai.template.pick', {
            'score_original': _tree_score(original_tree),
            'score_translated': _tree_score(translated_tree),
            'picked': 'original' if template_tree is original_tree else ('translated' if template_tree is translated_tree else 'none'),
        })
        if not isinstance(template_tree, dict):
            template_tree = original_tree if isinstance(original_tree, dict) else (
                translated_tree if isinstance(translated_tree, dict) else {})
        patched = core.patch(
            {'Ai': {'aiTextFull': str(
                ai.get('aiTextFull') or ''), 'aiTree': template_tree}},
            W,
            H,
            thai_font or '',
            latin_font or '',
            lang=target_lang,
        )
        ai_tree = (patched.get('Ai') or {}).get('aiTree') or {}
        _dbg('ai.patched', {
            'ai_text_len': len(str(ai.get('aiTextFull') or '')),
            'stats_ai': _tree_stats(ai_tree),
            'stats_original': _tree_stats(original_tree or {}),
            'stats_translated': _tree_stats(translated_tree or {}),
            'mode': mode_id,
            'lang': target_lang,
        })

        shared_para_sizes = core._compute_shared_para_sizes(
            [original_tree or {}, translated_tree or {}, ai_tree or {}],
            thai_font or '',
            latin_font or '',
            W,
            H,
        )
        core._apply_para_font_size(original_tree or {}, shared_para_sizes)
        core._apply_para_font_size(translated_tree or {}, shared_para_sizes)
        core._apply_para_font_size(ai_tree or {}, shared_para_sizes)
        core._rebuild_ai_spans_after_font_resize(
            ai_tree or {}, W, H, thai_font or '', latin_font or '', lang=target_lang)

        out['AiTextFull'] = str(ai.get('aiTextFull') or '')
        out['Ai'] = {
            'aiTextFull': str(ai.get('aiTextFull') or ''),
            'aiTree': ai_tree,
            'meta': ai.get('meta') or {},
        }
        if getattr(core, 'DO_AI_HTML', True):
            core.fit_tree_font_sizes_for_tp_html(
                ai_tree, thai_font or '', latin_font or '', W, H)
            out['Ai']['aihtml'] = core.ai_tree_to_tp_html(ai_tree, W, H)
            out['Ai']['aihtmlMeta'] = {
                'baseW': int(W),
                'baseH': int(H),
                'format': 'tp',
            }

    if getattr(core, 'DO_ORIGINAL', True) and getattr(core, 'DO_ORIGINAL_HTML', True) and isinstance(original_tree, dict):
        core.fit_tree_font_sizes_for_tp_html(
            original_tree, thai_font or '', latin_font or '', W, H)
        if isinstance(out.get('original'), dict):
            out['original']['originalhtml'] = core.ai_tree_to_tp_html(
                original_tree or {}, W, H)

    if getattr(core, 'DO_TRANSLATED', True) and getattr(core, 'DO_TRANSLATED_HTML', True) and isinstance(translated_tree, dict):
        core.fit_tree_font_sizes_for_tp_html(
            translated_tree, thai_font or '', latin_font or '', W, H)
        if isinstance(out.get('translated'), dict):
            out['translated']['translatedhtml'] = core.ai_tree_to_tp_html(
                translated_tree or {}, W, H)

    if getattr(core, 'HTML_INCLUDE_CSS', True) and (getattr(core, 'DO_ORIGINAL_HTML', True) or getattr(core, 'DO_TRANSLATED_HTML', True) or getattr(core, 'DO_AI_HTML', True)):
        out['htmlCss'] = core.tp_overlay_css()
        out['htmlMeta'] = {
            'baseW': int(W),
            'baseH': int(H),
            'format': 'tp',
        }
    base_img = _base_img_for_overlay()
    buf = io.BytesIO()
    base_img.save(buf, format='PNG')
    out['imageDataUri'] = _bytes_to_datauri(buf.getvalue(), 'image/png')

    return out

app = FastAPI(title='TextPhantom OCR API', version='1.0')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

async def _cleanup_jobs_loop():
    while True:
        await asyncio.sleep(60)
        cutoff = _now() - JOB_TTL_SEC
        dead = [jid for jid, j in _jobs.items() if float(
            j.get('ts', 0)) < cutoff]
        for jid in dead:
            _jobs.pop(jid, None)

async def _worker_loop(worker_id: int):
    while True:
        jid, payload = await _job_queue.get()
        try:
            _jobs[jid] = {'status': 'running', 'ts': _now()}
            result = await asyncio.to_thread(_process_payload, payload)
            _jobs[jid] = {'status': 'done', 'result': result, 'ts': _now()}
        except Exception as e:
            _jobs[jid] = {'status': 'error', 'result': str(e), 'ts': _now()}
        finally:
            _job_queue.task_done()

def _process_payload(payload: dict) -> dict:
    t_all = time.perf_counter()
    mode = (payload.get('mode') or 'lens_images')
    lang = (payload.get('lang') or 'en')

    src = (payload.get('src') or '').strip()
    img_bytes = b''
    mime = ''

    if payload.get('imageDataUri'):
        img_bytes, mime = _datauri_to_bytes(payload.get('imageDataUri'))
    elif src.startswith('data:'):
        img_bytes, mime = _datauri_to_bytes(src)
    else:
        img_bytes, mime = _download_bytes(src)

    t_img = time.perf_counter()

    if not img_bytes:
        raise Exception('No image data')

    ai_cfg = None
    ai = payload.get('ai') or None
    source = str(payload.get('source') or '').strip().lower() or 'translated'
    if mode == 'lens_text' and source == 'ai' and isinstance(ai, dict):
        api_key = str(ai.get('api_key') or '').strip() or (
            os.getenv('AI_API_KEY') or '').strip()
        ai_cfg = AiConfig(
            api_key=api_key,
            model=str(ai.get('model') or 'auto').strip() or 'auto',
            provider=str(ai.get('provider') or 'auto').strip() or 'auto',
            base_url=str(ai.get('base_url') or 'auto').strip() or 'auto',
            prompt_editable=str(ai.get('prompt') or '').strip(),
        )

    core.DO_AI_JSON = False

    img_hash = _sha256_hex(img_bytes)
    cache_key = ''
    if mode == 'lens_text' and img_hash:
        cache_key = _build_cache_key(img_hash, lang, mode, source, ai_cfg)
        cached = None
        if source == 'ai':
            cached = _lru_get(_ai_result_cache, _ai_cache_lock, cache_key)
        else:
            cached = _lru_get(_result_cache, _result_cache_lock, cache_key)
        if cached:
            cached['perf'] = {
                'cache': 'hit',
                'total_ms': round((time.perf_counter() - t_all) * 1000, 1),
                'img_ms': round((t_img - t_all) * 1000, 1),
            }
            return cached

    suffix = '.png' if (mime or '').endswith('png') else '.jpg'
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
        f.write(img_bytes)
        tmp_path = f.name
    t_tmp = time.perf_counter()
    try:
        out = process_image_path(tmp_path, lang, mode, ai_cfg)
        out['perf'] = {
            'cache': 'miss' if cache_key else 'off',
            'total_ms': round((time.perf_counter() - t_all) * 1000, 1),
            'img_ms': round((t_img - t_all) * 1000, 1),
            'tmp_ms': round((t_tmp - t_img) * 1000, 1),
        }
        if cache_key and isinstance(out, dict):
            if source == 'ai':
                _lru_set(_ai_result_cache, _ai_cache_lock, cache_key, out, TP_AI_RESULT_CACHE_MAX)
            else:
                _lru_set(_result_cache, _result_cache_lock, cache_key, out, TP_RESULT_CACHE_MAX)
        return out
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass

@app.on_event('startup')
async def _startup():
    print(
        f'[TextPhantom][api] starting build={BUILD_ID} workers={SERVER_MAX_WORKERS}')
    for i in range(max(1, SERVER_MAX_WORKERS)):
        asyncio.create_task(_worker_loop(i))
    asyncio.create_task(_cleanup_jobs_loop())

@app.get('/health')
async def health():
    return {'ok': True, 'build': BUILD_ID}

@app.get('/version')
async def version():
    return {'ok': True, 'build': BUILD_ID, 'core': 'lens_core'}

@app.get('/warmup')
async def warmup(lang: str = TP_WARMUP_LANG):
    t0 = time.perf_counter()
    r = core.warmup(lang)
    return {'ok': True, 'build': BUILD_ID, 'dt_ms': round((time.perf_counter() - t0) * 1000, 1), 'result': r}

@app.get('/meta')
async def meta():
    langs = getattr(core, 'UI_LANGUAGES', None) or []
    sources = [
        {'id': 'original', 'name': 'Original'},
        {'id': 'translated', 'name': 'Translated'},
        {'id': 'ai', 'name': 'Ai'},
    ]
    env_key = (os.getenv('AI_API_KEY') or '').strip()
    return {'ok': True, 'languages': langs, 'sources': sources, 'has_env_ai_key': bool(env_key)}

@app.post('/translate')
async def translate(payload: Dict[str, Any]):
    jid = str(uuid.uuid4())
    _jobs[jid] = {'status': 'queued', 'ts': _now()}
    await _job_queue.put((jid, payload))
    return {'id': jid}

@app.get('/translate/{job_id}')
async def translate_status(job_id: str):
    j = _jobs.get(job_id)
    if not j:
        return {'status': 'error', 'result': 'job_not_found'}
    return j

@app.post('/ai/resolve')
async def ai_resolve(payload: Dict[str, Any]):
    api_key = str(payload.get('api_key') or '').strip() or (
        os.getenv('AI_API_KEY') or '').strip()
    lang = _normalize_lang(str(payload.get('lang') or 'en'))
    if not api_key:
        return {
            'ok': False,
            'error': 'missing_api_key',
            'provider': '',
            'default_model': '',
            'models': [],
            'lang': lang,
            'prompt_editable_default': (getattr(core, 'ai_prompt_user_default', lambda _l: '')(lang) or '').strip(),
        }

    provider = core._canonical_provider(str(payload.get('provider') or 'auto'))
    if provider in ('', 'auto'):
        provider = _detect_provider_from_key(api_key)

    preset = _resolve_provider_defaults(provider) or {}
    requested_model = str(payload.get('model') or 'auto').strip() or 'auto'
    resolved_model = _resolve_model(provider, requested_model)

    models: List[str] = []
    base_url = (str(payload.get('base_url') or 'auto')).strip()
    if base_url in ('', 'auto'):
        base_url = (preset.get('base_url') or '').strip()

    if provider == 'huggingface':
        if base_url:
            models = core._hf_router_available_models(api_key, base_url)
        if requested_model.lower() in ('', 'auto'):
            fallback = core._pick_hf_fallback_model(models)
            if fallback:
                resolved_model = fallback

    elif provider == 'gemini':
        models = getattr(core, '_gemini_available_models',
                         lambda _k: [])(api_key)
        if not models:
            models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro',
                      'gemini-2.0-flash', 'gemini-3-flash-preview', 'gemini-3-pro-preview']

    elif provider == 'anthropic':
        models = getattr(core, '_anthropic_available_models',
                         lambda _k, _b=None: [])(api_key, base_url)

    else:
        if not base_url:
            base_url = (core.AI_PROVIDER_DEFAULTS.get('openai') or {}).get(
                'base_url') or 'https://api.openai.com/v1'
        models = getattr(core, '_openai_compat_available_models',
                         lambda _k, _b: [])(api_key, base_url)

    if provider == 'huggingface' and not models:
        models = [
            'google/gemma-3-27b-it:featherless-a',
        ]

    if not models:
        fallback_models: List[str] = []
        preset_model = str(preset.get('model') or '').strip()
        if preset_model:
            fallback_models.append(preset_model)

        provider_defaults = (getattr(core, 'AI_PROVIDER_DEFAULTS', {}) or {}).get(
            provider, {}) or {}
        provider_model = str(provider_defaults.get('model') or '').strip()
        if provider_model:
            fallback_models.append(provider_model)

        if provider == 'gemini':
            fallback_models.extend([
                'gemini-2.5-flash',
                'gemini-2.5-flash-lite',
                'gemini-2.5-pro',
                'gemini-2.0-flash',
                'gemini-3-flash-preview',
                'gemini-3-pro-preview',
            ])

        models = sorted(set([m for m in fallback_models if m]), key=str.lower)

        if not models:
            all_models: List[str] = []
            for _, v in (getattr(core, 'AI_PROVIDER_DEFAULTS', {}) or {}).items():
                m2 = str((v or {}).get('model') or '').strip()
                if m2:
                    all_models.append(m2)
            models = sorted(set(all_models), key=str.lower)

    if models:
        models = sorted(
            {m.strip() for m in models if isinstance(m, str) and m.strip()},
            key=str.lower,
        )

    if models and requested_model.lower() in ('', 'auto') and resolved_model not in models:
        resolved_model = models[0]

    prompt_default = (getattr(core, 'ai_prompt_user_default',
                      lambda _l: '')(lang) or '').strip()

    return {
        'ok': True,
        'provider': provider,
        'base_url': base_url,
        'default_model': (preset.get('model') or ''),
        'model': resolved_model,
        'models': models,
        'prompt_editable_default': prompt_default,
    }

@app.get('/ai/prompt/default')
async def ai_prompt_default(lang: str = 'en'):
    l = _normalize_lang(lang)
    return {
        'ok': True,
        'lang': l,
        'prompt_editable_default': (getattr(core, 'ai_prompt_user_default', lambda _l: '')(l) or '').strip(),
        'lang_style': (getattr(core, 'AI_LANG_STYLE', {}) or {}).get(l) or (getattr(core, 'AI_LANG_STYLE', {}) or {}).get('default') or '',
        'system_base': (getattr(core, 'AI_PROMPT_SYSTEM_BASE', '') or '').strip(),
        'contract': core._active_ai_contract(),
        'data_template': core._active_ai_data_template(),
    }

@app.websocket('/ws')
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    await ws.send_text(json.dumps({'type': 'ack'}))
    try:
        while True:
            msg = await ws.receive_text()
            data = json.loads(msg)
            if data.get('type') != 'job':
                continue
            jid = str(data.get('id') or '')
            payload = data.get('payload') or {}
            try:
                result = await asyncio.to_thread(_process_payload, payload)
                try:
                    await ws.send_text(json.dumps({'type': 'result', 'id': jid, 'result': result}))
                except WebSocketDisconnect:
                    return
            except Exception as e:
                try:
                    await ws.send_text(json.dumps({'type': 'error', 'id': jid, 'error': str(e)}))
                except (WebSocketDisconnect, RuntimeError):
                    return
    except WebSocketDisconnect:
        return

def main():
    image_path = getattr(core, 'IMAGE_PATH', '')
    lang = getattr(core, 'LANG', 'en')
    mode = os.environ.get('MODE', 'lens_text')
    ai_key = os.environ.get('AI_API_KEY', getattr(core, 'AI_API_KEY', ''))
    ai_model = os.environ.get('AI_MODEL', getattr(core, 'AI_MODEL', 'auto'))
    ai_prompt = os.environ.get('AI_PROMPT', '')

    ai_cfg = AiConfig(api_key=ai_key, model=ai_model,
                      prompt_editable=ai_prompt) if ai_key and mode == 'lens_text' else None
    out = process_image_path(image_path, lang, mode, ai_cfg)
    print(json.dumps(out, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
