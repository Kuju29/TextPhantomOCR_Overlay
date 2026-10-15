"""Fixed-origin consumer HTTPS and strict SSE framing. No credential logging."""
import json
import re
import time
import math
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from threading import Event, Thread
from urllib.parse import urlsplit
import httpx
from ..login_provider_contract import LoginError
from .. import login_observability as diagnostic

UPLOAD_URLS = {'login_gemini': ('https://content-push.googleapis.com/upload',)}
ORIGINS = {'login_gemini': 'https://gemini.google.com', 'login_claude': 'https://claude.ai',
           'login_deepseek': 'https://chat.deepseek.com', 'login_chatgpt': 'https://chatgpt.com',
           # Sign in with ChatGPT requests leave from the extension (its own token).
           'login_chatgpt_official': 'https://api.openai.com'}
MAX_BYTES = 8 * 1024 * 1024
ENDPOINT_STEPS = frozenset({'deepseek_identity', 'deepseek_session_create', 'deepseek_pow_challenge',
    'deepseek_completion', 'claude_identity', 'claude_organizations', 'claude_catalogue',
    'claude_completion', 'gemini_bootstrap', 'gemini_completion', 'consumer_endpoint',
    'chatgpt_identity', 'chatgpt_catalogue', 'chatgpt_native_prepare', 'chatgpt_completion',
    'gemini_image_upload', 'claude_image_upload', 'chatgpt_website_probe', 'chatgpt_website_turn'})

def invalid(message='The consumer endpoint returned an incomplete or unknown response.', reason='invalid_response'):
    error = LoginError('login_endpoint_response_invalid', message, 502)
    error.provider_reason = reason
    return error

SITE_NAMES = {'login_deepseek': 'DeepSeek', 'login_claude': 'Claude', 'login_gemini': 'Gemini',
              'login_chatgpt': 'ChatGPT', 'login_chatgpt_official': 'ChatGPT'}
# HTTP statuses that mean the website's own server failed or is overloaded
# (RFC 9110 server errors). Not a TextPhantom, account or request fault.
PROVIDER_SERVER_STATUSES = frozenset({500, 502, 503, 504})

def provider_unavailable(provider, reason='provider_server_error', retry_after=None):
    """The website's server failed this request (busy/overloaded/5xx). Retry later."""
    site = SITE_NAMES.get(provider, 'The AI website')
    error = LoginError('login_provider_temporarily_unavailable',
                       site + "'s server is temporarily unavailable. Try again later.", 503)
    error.provider_reason = reason
    error.retryable = True
    delay = retry_after_ms(retry_after) if retry_after is not None else 0
    if delay:
        error.retry_after_ms = delay
    return error

def response_shape(content_type, raw):
    """Structural evidence of a provider reply: kind, size, enum keys and
    integer status codes only. Never body text, messages, IDs or credentials."""
    data = bytes(raw or b'')
    kind = ('empty' if not data.strip() else 'sse' if 'text/event-stream' in content_type else
            'json' if 'json' in content_type else 'html' if 'html' in content_type else 'other')
    shape = {'schema': 'tp.login_endpoint_response_shape/1', 'kind': kind, 'bytes': len(data)}
    if kind == 'json':
        try:
            value = json.loads(data)
        except (ValueError, UnicodeError):
            value = None
        if isinstance(value, dict):
            shape['keys'] = sorted(k for k in value if isinstance(k, str) and re.fullmatch(r'[A-Za-z_]{1,40}', k))[:20]
            nested = value.get('data') if isinstance(value.get('data'), dict) else {}
            for key, source in (('code', value), ('bizCode', {'bizCode': nested.get('biz_code')})):
                item = source.get(key)
                if type(item) is int:
                    shape[key] = item
    elif kind == 'sse':
        events = []
        for line in data.decode('utf-8', 'replace').splitlines():
            if line.startswith('event:'):
                name = line[6:].strip()
                if re.fullmatch(r'[A-Za-z0-9_.-]{1,40}', name) and name not in events:
                    events.append(name)
        shape['events'] = events[:20]
        shape['complete'] = data.replace(b'\r\n', b'\n').endswith(b'\n\n')
    return shape

def endpoint_step(provider, path):
    """Static route labels only; never expose conversation IDs or request data."""
    exact = {
        ('login_deepseek', '/api/v0/users/current'): 'deepseek_identity',
        ('login_deepseek', '/api/v0/chat_session/create'): 'deepseek_session_create',
        ('login_deepseek', '/api/v0/chat/create_pow_challenge'): 'deepseek_pow_challenge',
        ('login_deepseek', '/api/v0/chat/completion'): 'deepseek_completion',
        ('login_claude', '/api/bootstrap'): 'claude_identity',
        ('login_claude', '/api/organizations'): 'claude_organizations',
        ('login_chatgpt', '/backend-api/me'): 'chatgpt_identity',
        ('login_chatgpt', '/backend-api/models'): 'chatgpt_catalogue',
        ('login_chatgpt', '/backend-api/sentinel/chat-requirements/prepare'): 'chatgpt_native_prepare',
        ('login_chatgpt', '/backend-api/f/conversation'): 'chatgpt_completion',
        ('login_chatgpt_official', '/v1/models'): 'chatgpt_catalogue',
        ('login_chatgpt_official', '/v1/responses'): 'chatgpt_completion',
    }
    if (provider, path) in exact:
        return exact[provider, path]
    if provider == 'login_claude':
        if re.fullmatch(r'/edge-api/bootstrap/[A-Za-z0-9_-]{1,160}/app_start', path):
            return 'claude_catalogue'
        if re.fullmatch(r'/api/organizations/[A-Za-z0-9_-]{1,160}/chat_conversations/[A-Za-z0-9_-]{1,160}/completion', path):
            return 'claude_completion'
        if re.fullmatch(r'/api/[A-Za-z0-9_-]{1,160}/upload', path):
            return 'claude_image_upload'
    if provider == 'login_gemini':
        if re.fullmatch(r'/(?:u/[0-9]{1,2}/)?app', path):
            return 'gemini_bootstrap'
        if 'StreamGenerate' in path:
            return 'gemini_completion'
    return 'consumer_endpoint'

def retry_after_ms(value):
    try:
        seconds = float(value)
    except (ValueError, TypeError):
        try:
            seconds = (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()
        except (ValueError, TypeError, OverflowError):
            return 0
    return math.ceil(min(86400, max(0, seconds)) * 1000) if math.isfinite(seconds) else 0


def challenge_reason(status, content_type, headers, raw):
    """Report explicit provider protection evidence, never infer it from HTML."""
    if headers.get('cf-mitigated', '').strip().lower() == 'challenge':
        return 'browser_challenge_header'
    if status not in (403, 429, 503) or 'text/html' not in content_type:
        return ''
    if b'/cdn-cgi/challenge-platform/' in raw:
        return 'browser_challenge_platform'
    if re.search(rb'<title>\s*Just a moment(?:\.\.\.)?\s*</title>', raw, re.I):
        return 'browser_challenge_title'
    return ''

def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', value):
        raise invalid()
    return value

class EndpointHTTP:
    def __init__(self, provider, headers, check=lambda: None):
        self.provider, self.origin, self.check = provider, ORIGINS[provider], check
        identity_headers = {} if provider == 'login_chatgpt' else {'Origin': self.origin, 'Referer': self.origin + '/'}
        self.client = httpx.Client(headers={'User-Agent': 'TextPhantom', **identity_headers, **headers},
            timeout=httpx.Timeout(30, connect=10), trust_env=False, follow_redirects=False)
        self.statuses = []
        self.response_shape = None
        self.endpoint_step = 'consumer_endpoint'
        self._stop = Event()
        self._cancel_error = None
        self._watcher = None

    def __enter__(self):
        deadline = time.monotonic() + 240
        def watch():
            while not self._stop.wait(.1):
                try:
                    self.check()
                    if time.monotonic() >= deadline:
                        raise LoginError('login_endpoint_timeout', 'The endpoint response timed out. Start a new run.', 504)
                except LoginError as error:
                    self._cancel_error = error
                    self.client.close()
                    return
        self._watcher = Thread(target=watch, daemon=True)
        self._watcher.start()
        return self

    def __exit__(self, *args):
        error = args[1] if len(args) > 1 else None
        if isinstance(error, LoginError) and self.statuses and not hasattr(error, 'upstream_status'):
            error.upstream_status = self.statuses[-1]
        if isinstance(error, LoginError) and not hasattr(error, 'endpoint_step'):
            error.endpoint_step = self.endpoint_step
        if isinstance(error, LoginError) and self.response_shape and not hasattr(error, 'response_shape'):
            # The last reply's structure, so an unreadable reply is evidence, not a guess.
            error.response_shape = dict(self.response_shape, endpointStep=self.endpoint_step)
        self._stop.set()
        self.client.close()
        if self._watcher:
            self._watcher.join(timeout=.3)

    def assert_current(self):
        if self._cancel_error is not None:
            raise self._cancel_error
        self.check()

    def upload(self, url, *, filename, data, mime, headers):
        """A page image to the website's own upload host. Only allow-listed
        URLs; no session cookie is forwarded to another host."""
        if url not in UPLOAD_URLS.get(self.provider, ()):
            raise LoginError('login_provider_contract', 'Invalid upload endpoint.', 503)
        self.assert_current()
        self.endpoint_step = self.provider.split('_', 1)[-1] + '_image_upload'
        diagnostic.stage('endpoint_validation')
        try:
            with httpx.Client(headers={'User-Agent': 'TextPhantom', 'Origin': self.origin, 'Referer': self.origin + '/'},
                              timeout=httpx.Timeout(60, connect=10), trust_env=False, follow_redirects=True,
                              max_redirects=3) as client:
                response = client.post(url, files={'file': (filename, data, mime)}, headers=headers)
            # The reference client follows the upload host's redirects; stay on that host.
            if response.url.scheme != 'https' or response.url.host != urlsplit(url).hostname:
                raise httpx.HTTPError('upload left its host')
        except httpx.HTTPError:
            self.check()
            error = LoginError('login_image_upload_failed', 'The page image could not be uploaded to the website.', 502)
            error.endpoint_step = self.endpoint_step
            raise error from None
        self.statuses.append(response.status_code)
        diagnostic.emit('provider_response', upstreamStatus=response.status_code, endpointStep=self.endpoint_step)
        self.assert_current()
        if response.status_code == 401:
            error = LoginError('login_session_expired', 'Reconnect your provider account.', 401)
            error.upstream_status, error.endpoint_step = 401, self.endpoint_step
            raise error
        if not 200 <= response.status_code < 300 or len(response.content) > 4096:
            error = LoginError('login_image_upload_failed', 'The website did not accept the page image.', 502)
            error.upstream_status = response.status_code
            error.endpoint_step = self.endpoint_step
            raise error
        return response.text

    def _outcome(self, status, content_type, headers, raw, expected, dispatch):
        """One status/body decision for both transports (API HTTPS and browser relay)."""
        self.response_shape = response_shape(content_type, raw)
        challenge = challenge_reason(status, content_type, headers, raw)
        if challenge:
            error = LoginError('login_endpoint_challenge_required',
                'The provider requires browser verification for this API connection. Endpoint translation is unavailable; no chat tab was opened.', 409)
            error.provider_reason = challenge
        elif status == 401 or 300 <= status < 400:
            error = LoginError('login_session_expired', 'Reconnect your provider account.', 401)
        elif status in (402, 429):
            error = LoginError('login_quota_exceeded', 'Your website account quota is unavailable.', 429)
            error.retry_after_ms = retry_after_ms(headers.get('retry-after'))
            error.retry_after = math.ceil(error.retry_after_ms / 1000)
        elif status == 403:
            # A chat turn refused with 403 while the session itself was accepted
            # is a model the account's plan cannot use.
            error = LoginError('login_provider_access_denied',
                'Your account on the website cannot use the selected model (it may need an upgraded plan). Choose another model in AI settings, then translate again.'
                if dispatch else
                'The provider denied this endpoint session. Check account access or reconnect; repeated translation retries will not restore access.', 403)
        elif status in PROVIDER_SERVER_STATUSES:
            error = provider_unavailable(self.provider, retry_after=headers.get('retry-after'))
        elif not 200 <= status < 300:
            error = LoginError('login_endpoint_rejected', 'The provider rejected this consumer endpoint request.', 502)
        elif expected == 'json' and 'json' not in content_type:
            error = invalid()
        elif expected == 'sse' and 'text/event-stream' not in content_type:
            error = invalid()
        else:
            self.assert_current()
            if expected == 'json':
                try:
                    return json.loads(raw)
                except (ValueError, UnicodeError):
                    raise invalid('The consumer endpoint returned invalid JSON.') from None
            return bytes(raw)
        error.upstream_status = status
        error.stage = 'endpoint_submit' if dispatch else 'endpoint_validation'
        error.endpoint_step = self.endpoint_step
        raise error

    def _relay(self, path, method, body, form, params, headers, dispatch, expected, files):
        """Send this request from the customer's own website tab (see
        login_browser_relay). Same path rules, statuses and decisions as HTTPS."""
        import base64
        from urllib.parse import urlencode
        from . import login_browser_relay as relay
        stage = 'endpoint_submit' if dispatch else 'endpoint_validation'
        job = {'provider': self.provider, 'method': method, 'path': path + ('?' + urlencode(params) if params else ''),
               'accept': (headers or {}).get('Accept', 'application/json'), 'expected': expected}
        if body is not None:
            job['json'] = body
        if files:
            if set(files) != {'file'} or not isinstance(form, dict) or not all(isinstance(v, str) for v in form.values()):
                raise LoginError('login_provider_contract', 'Invalid relay upload.', 503)
            name, data, mime = files['file']
            job['multipart'] = {'fields': dict(form), 'file': {'field': 'file', 'name': name, 'mime': mime,
                                'base64': base64.b64encode(data).decode('ascii')}}
        elif form:
            raise LoginError('login_provider_contract', 'Invalid relay form.', 503)
        if dispatch:
            dispatch()
        try:
            result, waited_ms = relay.submit(job, self.assert_current)
        except relay.RelayUnavailable:
            error = LoginError('login_browser_relay_unavailable',
                'TextPhantom could not reach a ' + self.origin.split('//', 1)[-1] + ' tab in this browser. Keep the browser open with the extension enabled, sign in to the website, then try again.', 503)
            error.stage, error.endpoint_step = stage, self.endpoint_step
            raise error from None
        except relay.RelayTimeout:
            error = LoginError('login_endpoint_timeout', 'The website tab did not finish this request in time. Start a new run.', 504)
            error.stage, error.endpoint_step = stage, self.endpoint_step
            raise error from None
        self.assert_current()
        if not isinstance(result, dict):
            raise invalid()
        if result.get('error'):
            # The tab could not send it (closed, navigated, network). No status
            # means the website may or may not have received a dispatched turn.
            code = result.get('error') if result.get('error') in ('tab_unavailable', 'network', 'not_allowed', 'signed_out', 'timeout') else 'network'
            detail = relay_detail(result)
            if code == 'signed_out':
                error = LoginError('login_session_expired', 'Sign in to the website in this browser, then reconnect.', 401)
            elif code == 'tab_unavailable' and detail == 'login_tab_closed':
                # The person closed the website tab during this translation. It is
                # not reopened until Translate is pressed again, so the person
                # learns the tab is needed.
                site = self.origin.split('//', 1)[-1]
                error = LoginError('login_work_tab_closed', 'The ' + site + ' tab used for this translation was closed. Press Translate again to open it.', 409)
            elif code == 'tab_unavailable':
                error = LoginError('login_browser_relay_unavailable', 'The website tab closed or could not load. Try again.', 503)
            elif code == 'not_allowed':
                error = LoginError('login_provider_contract', 'The extension refused this website request.', 503)
            elif code == 'timeout':
                # Say which part did not finish.
                site = self.origin.split('//', 1)[-1]
                message = ('The ' + site + ' tab did not run the request (the browser may have put it to sleep). Open that tab once, then try again.'
                           if detail == 'login_tab_script_timeout' else
                           site + ' did not finish this answer in time. Try again; if it repeats, open ' + site + ' and check the chat there.'
                           if detail == 'login_page_fetch_timeout' else
                           'The website tab did not answer in time. Reload that tab and try again.')
                error = LoginError('login_endpoint_timeout', message, 504)
            else:
                error = LoginError('login_endpoint_transport_failed',
                    'The endpoint response could not be confirmed. This message will not be resent automatically.', 502)
            error.stage, error.endpoint_step = stage, self.endpoint_step
            diagnostic.emit('provider_response', endpointStep=self.endpoint_step, transport='browser_relay', relayError=code,
                            relayDetail=detail, relayWaitMs=waited_ms)
            raise error
        status = result.get('status')
        text = result.get('body', '')
        if type(status) is not int or not 100 <= status <= 599 or not isinstance(text, str) or len(text) > MAX_BYTES:
            raise invalid()
        raw = text.encode('utf-8')
        if len(raw) > MAX_BYTES:
            raise invalid('The consumer endpoint response exceeded its limit.')
        self.statuses.append(status)
        diagnostic.emit('provider_response', upstreamStatus=status, endpointStep=self.endpoint_step,
                        transport='browser_relay', relayWaitMs=waited_ms)
        rheaders = result.get('headers') if isinstance(result.get('headers'), dict) else {}
        rheaders = {str(k).lower(): str(v)[:200] for k, v in rheaders.items() if str(k).lower() in ('cf-mitigated', 'retry-after')}
        content_type = str(result.get('content_type', '')).lower()[:200]
        try:
            return self._outcome(status, content_type, rheaders, raw, expected, dispatch)
        except LoginError as error:
            if error.code == 'login_endpoint_challenge_required':
                # The tab itself was asked to verify; the person can finish that check.
                error.args = ('The website asked this browser to verify. Open the ' + self.origin.split('//', 1)[-1] +
                              ' tab, complete the check, then try again.',)
            if not hasattr(error, 'upstream_status'):
                error.upstream_status = status
            if not hasattr(error, 'endpoint_step'):
                error.endpoint_step = self.endpoint_step
            if not hasattr(error, 'stage'):
                error.stage = stage
            raise

    def request(self, path, *, method='GET', body=None, form=None, params=None,
                headers=None, dispatch=None, expected='json', files=None):
        if not isinstance(path, str) or not path.startswith('/') or path.startswith('//') or \
                urlsplit(path).scheme or urlsplit(path).netloc or '#' in path or '?' in path:
            raise LoginError('login_provider_contract', 'Invalid consumer endpoint path.', 503)
        self.assert_current()
        self.endpoint_step = endpoint_step(self.provider, path)
        diagnostic.stage('endpoint_submit' if dispatch else 'endpoint_validation')
        from .login_browser_relay import RELAY_PROVIDERS
        if self.provider in RELAY_PROVIDERS:
            return self._relay(path, method, body, form, params, headers, dispatch, expected, files)
        if dispatch:
            dispatch()
        status = None
        try:
            with self.client.stream(method, self.origin + path, json=body, data=form, files=files,
                                    params=params, headers=headers) as response:
                status = response.status_code
                self.statuses.append(status)
                diagnostic.emit('provider_response', upstreamStatus=status, endpointStep=self.endpoint_step)
                raw = bytearray()
                for chunk in response.iter_bytes():
                    self.assert_current()
                    if len(raw) + len(chunk) > MAX_BYTES:
                        raise invalid('The consumer endpoint response exceeded its limit.')
                    raw.extend(chunk)
                content_type = response.headers.get('content-type', '').lower()
                return self._outcome(status, content_type, response.headers, raw, expected, dispatch)
        except LoginError as error:
            if status is not None and not hasattr(error, 'upstream_status'):
                error.upstream_status = status
            if not hasattr(error, 'endpoint_step'):
                error.endpoint_step = self.endpoint_step
            if not hasattr(error, 'stage'):
                error.stage = 'endpoint_submit' if dispatch else 'endpoint_validation'
            raise
        except (httpx.HTTPError, ValueError, TypeError, RuntimeError, OSError):
            if self._cancel_error is not None:
                raise self._cancel_error from None
            self.check()
            error = LoginError('login_endpoint_transport_failed',
                'The endpoint response could not be confirmed. This message will not be resent automatically.', 502)
            if status is not None:
                error.upstream_status = status
            error.endpoint_step = self.endpoint_step
            raise error from None

def sse(raw):
    try:
        text = raw.decode('utf-8').replace('\r\n', '\n').replace('\r', '\n')
        records = text.split('\n\n')
        if records[-1].strip():
            raise ValueError()
        for record in records[:-1]:
            kind = next((line[6:].strip() for line in record.split('\n') if line.startswith('event:')), '')
            data = '\n'.join(line[5:].lstrip(' ') for line in record.split('\n') if line.startswith('data:'))
            if not data:
                continue
            yield kind, json.loads(data)
    except (UnicodeError, ValueError, TypeError):
        raise invalid() from None

def model(identifier, label):
    return {'id': identifier, 'name': label, 'model_capabilities': {
        'structured_output': {'supported': False}, 'vision': {'supported': False},
        'reasoning': {'supported': None, 'control': 'provider', 'app_controlled': False}},
        '_metadata': {'transport': 'web_endpoint'}}


# The browser's reason when a website tab was not ready (codes from the
# extension's own DOM checks; never text from the website).
NOT_READY = {
    'login_composer_missing': 'The ChatGPT chat box was not found in the tab. Open chatgpt.com, close any pop-up, then try again.',
    'login_composer_disabled': 'The ChatGPT chat box is disabled in the tab. Open chatgpt.com, finish any prompt there, then try again.',
    'login_session_http_error': 'chatgpt.com did not confirm your sign-in. Reload the chatgpt.com tab, then try again.',
    'login_session_content_invalid': 'chatgpt.com did not confirm your sign-in. Reload the chatgpt.com tab, then try again.',
    'login_session_probe_timeout': 'chatgpt.com answered too slowly. Reload the chatgpt.com tab, then try again.',
    'login_session_probe_failed': 'chatgpt.com could not be checked. Reload the chatgpt.com tab, then try again.',
    'login_browser_timeout': 'The chatgpt.com tab did not finish loading. Reload it, then try again.',
    'login_tab_loading': 'The chatgpt.com tab was still loading and did not answer. Open the tab, wait until the chat box shows, then try again.',
    'login_tab_discarded': 'The browser put the chatgpt.com tab to sleep. Open that tab once, then try again.',
    'login_dom_error': 'TextPhantom could not read the chatgpt.com page. Reload the tab, then try again.',
    'login_dom_wrong_reply': 'Another script in the chatgpt.com tab answered instead of TextPhantom. Reload the tab, then try again.',
    'login_inject_failed': 'TextPhantom could not run in the chatgpt.com tab. Reload it (and allow the extension on that site), then try again.',
    'login_tab_disconnected': 'The chatgpt.com tab reloaded while it was being checked. Try again.',
}


def relay_detail(result):
    detail = result.get('detail') if isinstance(result, dict) else ''
    return detail if isinstance(detail, str) and re.fullmatch(r'[a-z_]{1,48}', detail) else ''


def relay_webchat(relay_provider, payload, check, dispatch=None):
    """One action in the customer's own provider website tab (ChatGPT free plan).

    The extension types the prompt into the website's composer and returns the
    finished answer; the website itself performs sign-in and request checks. The
    API never sees a cookie or token and never retries a dispatched turn."""
    from . import login_browser_relay as relay
    action = payload.get('action')
    step = 'chatgpt_website_turn' if action == 'turn' else 'chatgpt_website_probe'
    stage = 'endpoint_submit' if dispatch else 'endpoint_validation'
    diagnostic.stage(stage)
    if dispatch:
        dispatch()
    def fail(code, message, status):
        error = LoginError(code, message, status)
        error.stage, error.endpoint_step = stage, step
        return error
    try:
        result, waited_ms = relay.submit({'provider': relay_provider, 'method': 'WEBCHAT', 'path': '/', 'webchat': dict(payload)}, check)
    except relay.RelayUnavailable:
        raise fail('login_browser_relay_unavailable',
                   'TextPhantom could not reach a chatgpt.com tab in this browser. Keep the browser open with the extension enabled, sign in to ChatGPT, then try again.', 503) from None
    except relay.RelayTimeout:
        raise fail('login_endpoint_timeout', 'The ChatGPT tab did not finish this answer in time. Start a new run.', 504) from None
    check()
    if not isinstance(result, dict):
        raise invalid()
    code = result.get('error')
    detail = relay_detail(result)
    diagnostic.emit('provider_response', endpointStep=step, transport='browser_relay', relayWaitMs=waited_ms,
                    **({'relayError': code, 'relayDetail': detail} if code else {'upstreamStatus': 200}))
    if code == 'not_ready':
        raise fail('login_provider_not_ready', NOT_READY.get(detail, 'The chatgpt.com tab was not ready. Reload it, then try again.'), 409)
    if code == 'timeout':
        raise fail('login_endpoint_timeout', 'The chatgpt.com tab did not answer in time. Reload it, then try again.', 504)
    if code:
        known = {
            'signed_out': ('login_session_expired', 'Sign in to ChatGPT in this browser, then connect again.', 401),
            'account_changed': ('login_account_changed', 'The ChatGPT account in this browser changed. Connect again.', 409),
            'chat_lost': ('login_chat_lost', 'The ChatGPT tab of this run was closed. Start a new translation run.', 409),
            'challenge': ('login_endpoint_challenge_required', 'ChatGPT asked this browser to verify. Open the chatgpt.com tab, complete the check, then try again.', 409),
            'limit': ('login_quota_exceeded', 'ChatGPT says the usage limit of this account is reached. Try again later.', 429),
            'busy': ('login_tab_busy', 'The ChatGPT tab is still answering another message. Try again shortly.', 409),
            'tab_unavailable': ('login_browser_relay_unavailable', 'The ChatGPT tab closed or could not load. Try again.', 503),
            'not_allowed': ('login_provider_contract', 'The extension refused this ChatGPT request.', 503),
        }
        if code == 'tab_unavailable' and detail == 'login_tab_closed':
            raise fail('login_work_tab_closed', 'The chatgpt.com tab used for this translation was closed. Press Translate again to open it.', 409)
        if code in known:
            raise fail(*known[code])
        raise fail('login_endpoint_transport_failed',
                   'The ChatGPT answer could not be confirmed. This message will not be resent automatically.', 502)
    if result.get('status') != 200 or not isinstance(result.get('body'), str) or len(result['body']) > MAX_BYTES:
        raise invalid()
    try:
        value = json.loads(result['body'])
    except ValueError:
        raise invalid() from None
    if not isinstance(value, dict):
        raise invalid()
    return value
