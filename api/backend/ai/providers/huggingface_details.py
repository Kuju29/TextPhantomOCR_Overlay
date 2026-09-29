"""Bounded, account-isolated selected-model metadata GET for HF only.

This is not a prompt cache or probe. No POST, retries, hidden route selection,
HF model config download or cross-account credential reuse takes place.
"""
from __future__ import annotations
from collections import OrderedDict
from concurrent.futures import Future
from copy import deepcopy
from threading import Lock
from urllib.parse import quote
import hashlib
import json
import time
import httpx
from .huggingface_catalogue import HUB_ID, split_model, selection_capabilities

_ENDPOINT = 'https://router.huggingface.co/v1'
_LOCK = Lock()
_CACHE = OrderedDict()
_PENDING = {}
_MAX_ENTRIES, _MAX_PENDING = 512, 64


def _key(base_url, api_key, model):
    base, _, policy = split_model(model)
    if base_url.rstrip('/') != _ENDPOINT or not api_key or not HUB_ID.fullmatch(base) or policy == 'invalid':
        return None
    return (_ENDPOINT, hashlib.sha256(api_key.encode()).hexdigest(), base)


def peek(base_url, api_key, model):
    key = _key(base_url, api_key, model)
    if key is None:
        return None
    with _LOCK:
        item = _CACHE.get(key)
        if item is None or item[0] <= time.monotonic():
            return None
        return deepcopy(item[1])


def discard_account(base_url, api_key):
    scope = (base_url.rstrip('/'), hashlib.sha256(api_key.encode()).hexdigest())
    with _LOCK:
        for key in list(_CACHE):
            if key[:2] == scope:
                _CACHE.pop(key, None)
        # Detach old readers. Their followers finish, but they cannot publish a
        # stale card after a later explicit catalogue refresh.
        for key in list(_PENDING):
            if key[:2] == scope:
                _PENDING.pop(key, None)


def refresh(base_url, api_key, model):
    key = _key(base_url, api_key, model)
    if key is None:
        return {}
    with _LOCK:
        item = _CACHE.get(key)
        if item and item[0] > time.monotonic():
            _CACHE.move_to_end(key)
            return selection_capabilities(item[1], model)
        pending = _PENDING.get(key)
        leader = pending is None
        if leader:
            if len(_PENDING) >= _MAX_PENDING:
                return {}  # Metadata pressure never monopolizes translation capacity.
            pending = Future()
            _PENDING[key] = pending
    if not leader:
        try:
            return selection_capabilities(pending.result(timeout=10), model)
        except TimeoutError:
            return {}
    card = None
    try:
        with httpx.Client(timeout=httpx.Timeout(8.0), follow_redirects=False) as client:
            with client.stream('GET', _ENDPOINT + '/models/' + quote(key[2], safe='/'),
                               headers={'Authorization': 'Bearer ' + api_key}) as response:
                if response.status_code == 200:
                    raw = bytearray()
                    start = time.monotonic()
                    for part in response.iter_bytes():
                        if len(raw) + len(part) > 1024 * 1024 or time.monotonic() - start > 8:
                            raise ValueError('HF model metadata exceeds budget')
                        raw.extend(part)
                    parsed = json.loads(raw)
                    if isinstance(parsed, dict) and parsed.get('id') == key[2] and isinstance(parsed.get('providers'), list):
                        card = parsed
        return selection_capabilities(card, model)
    except (httpx.RequestError, ValueError, TypeError):
        return {}  # Unknown remains unknown; never disable an otherwise usable model.
    finally:
        with _LOCK:
            if _PENDING.get(key) is pending:
                _CACHE[key] = (time.monotonic() + (300 if card is not None else 30), card)
                _CACHE.move_to_end(key)
                while len(_CACHE) > _MAX_ENTRIES:
                    _CACHE.popitem(last=False)
                _PENDING.pop(key, None)
            else:
                card = None
            pending.set_result(card)
