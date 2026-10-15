"""ChatGPT Login: the customer's own browser sends every ChatGPT request.

The API keeps prompt/conversation logic and hands each request to the same
owner's extension (login_browser_relay), because the API's own HTTPS client
gets browser challenges:
- official (paid plans): the extension calls api.openai.com with its locally
  stored "Sign in with ChatGPT" token; the token never reaches this API.
- website (free plans): the extension types the prompt in its own chatgpt.com
  tab and returns the finished answer text.
Nothing here imitates a browser or creates/replays integrity, proof or challenge data.

AI think (10492, docs/login-web-fields-10492.md): no ENDPOINT_THINKING here.
- website: chatgpt.com itself posts /backend-api/f/conversation (with its own
  sentinel/turnstile proofs) using the model and effort chosen in its own
  picker; TextPhantom only types and sends, so it cannot add a thinking_effort
  or system_hints field without forging that request.
- official: the /v1/models rows read here carry no reasoning fields and the
  repository documents no reasoning parameter for this token's /v1/responses
  route, so the body stays {model, input, store, stream} (provider default).
"""
import re
from .login_provider_contract import LoginProvider, LoginError
from .endpoint.login_endpoint_http import EndpointHTTP, invalid, model, sse, relay_webchat, provider_unavailable

PROVIDER = LoginProvider('login_chatgpt', 'ChatGPT', 'web_endpoint', 'chatgpt.com', '/', 0, '')
OFFICIAL, WEBSITE = 'official', 'website'
OFFICIAL_RELAY, WEBSITE_RELAY = 'login_chatgpt_official', 'login_chatgpt_web'
WEBSITE_MODEL = 'web-current'
ENDPOINT_IMAGES = True  # official models that list image input; the website model has no vision
MAX_HISTORY_TURNS = 60
MAX_HISTORY_CHARS = 400_000
ACCOUNT = re.compile(r'[a-f0-9]{64}')
PLAN = re.compile(r'[a-z0-9_.-]{1,40}')


def mode_of(credentials):
    mode = credentials.get('mode') if isinstance(credentials, dict) else None
    if mode not in (OFFICIAL, WEBSITE):
        raise LoginError('login_reconnect_required', 'Update the extension and API together, then connect ChatGPT again.', 401)
    return mode


def identity_of(credentials):
    return 'chatgpt-' + mode_of(credentials) + '\0' + credentials['account']


def official_model(row):
    slug = row.get('slug') if isinstance(row, dict) else None
    if not isinstance(slug, str) or not 1 <= len(slug) <= 128 or any(ord(c) < 33 or ord(c) > 126 for c in slug):
        raise invalid('ChatGPT returned an invalid model catalogue.')
    title = row.get('display_name') or row.get('title')
    label = title if isinstance(title, str) and title.strip() and len(title) <= 160 else slug
    result = model(slug, label + ' · ChatGPT plan (Sign in with ChatGPT)')
    modalities = row.get('input_modalities')
    if isinstance(modalities, list) and 'image' in modalities:
        result['model_capabilities']['vision'] = {'supported': True, 'source': 'chatgpt_official'}
    result['_metadata'] = {'transport': 'web_endpoint', 'chatgpt_mode': OFFICIAL}
    return result


def website_model():
    result = model(WEBSITE_MODEL, 'ChatGPT website · model chosen on chatgpt.com')
    result['_metadata'] = {'transport': 'web_endpoint', 'chatgpt_mode': WEBSITE}
    return result


def official_catalogue(http):
    value = http.request('/v1/models')
    source = value.get('models', value.get('data')) if isinstance(value, dict) else None
    if not isinstance(source, list) or not 1 <= len(source) <= 1000:
        raise invalid('ChatGPT did not return its model catalogue.')
    rows, seen = [], set()
    for item in source:
        if not isinstance(item, dict):
            raise invalid('ChatGPT returned an invalid model catalogue.')
        # Only models the plan lists for people; hidden/internal rows are skipped.
        if item.get('visibility') not in (None, 'list'):
            continue
        row = official_model(item)
        if row['id'] not in seen:
            seen.add(row['id'])
            rows.append(row)
    if not 1 <= len(rows) <= 100:
        raise invalid('ChatGPT did not return a usable model catalogue.')
    return rows


def endpoint_authenticate(credentials, check):
    return {**endpoint_validate(credentials, check), 'models': [], 'authentication_only': True}


def endpoint_validate(credentials, check):
    mode = mode_of(credentials)
    from . import login_observability as diagnostic
    # Which route the extension chose and the plan word it read (no ids).
    diagnostic.emit('chatgpt_route', chatgptMode=mode, chatgptPlan=str(credentials.get('plan') or 'unknown'))
    if mode == OFFICIAL:
        with EndpointHTTP(OFFICIAL_RELAY, {}, check) as http:
            rows = official_catalogue(http)
    else:
        probe = relay_webchat(WEBSITE_RELAY, {'action': 'probe', 'account': credentials['account']}, check)
        if probe.get('ready') is not True or probe.get('account') != credentials['account']:
            raise LoginError('login_account_changed', 'The ChatGPT account in this browser changed. Sign in again.', 409)
        rows = [website_model()]
    return {'identity': identity_of(credentials), 'credentials': dict(credentials), 'models': rows}


def endpoint_model_rows(rows):
    return rows


def parse_responses(raw):
    """Responses API stream -> (text, usage). Only a response.completed event counts."""
    text, completed, usage = [], None, None
    for _kind, event in sse(raw if raw.endswith(b'\n\n') else raw + b'\n\n'):
        if not isinstance(event, dict):
            raise invalid()
        kind = event.get('type')
        if kind == 'response.output_text.delta':
            if not isinstance(event.get('delta'), str):
                raise invalid()
            text.append(event['delta'])
        elif kind in ('response.failed', 'error'):
            error = (event.get('response') or {}).get('error') if kind == 'response.failed' else event.get('error', event)
            code = str((error or {}).get('code') or '') if isinstance(error, dict) else ''
            if code in ('rate_limit_exceeded', 'usage_limit_reached', 'insufficient_quota'):
                raise LoginError('login_quota_exceeded', 'Your ChatGPT plan limit is reached for now. Try again later or choose another model.', 429)
            if code == 'server_error':
                # The Responses API's documented code for OpenAI's own server failure.
                raise provider_unavailable('login_chatgpt_official')
            raise LoginError('login_endpoint_rejected', 'ChatGPT stopped this answer with an error.', 502)
        elif kind == 'response.incomplete':
            raise LoginError('login_endpoint_rejected', 'ChatGPT returned an incomplete answer.', 502)
        elif kind == 'response.completed':
            completed = event.get('response') if isinstance(event.get('response'), dict) else {}
            usage = completed.get('usage') if isinstance(completed.get('usage'), dict) else None
    if completed is None:
        raise invalid('ChatGPT did not confirm a complete answer.')
    return ''.join(text), usage


def _history_chars(history):
    return sum(len(part.get('text', '')) for item in history for part in item.get('content', []))


# chatgpt.com's formatter strips anything that looks like a tag, which turns
# <<ID:text>> records into bare ">". A code block is shown verbatim and the
# extension reads its text. Appended to every website turn only.
WEBSITE_REPLY_FORMAT = ('\n\nReply format for this website: put the whole reply inside one code block '
                        'that starts with ```text and ends with ```, and write nothing outside it.')


def endpoint_generate(credentials, prompt, remote, selected, check, dispatch, image=None):
    mode = mode_of(credentials)
    if not isinstance(remote, dict):
        raise invalid('The retained ChatGPT conversation is invalid.')
    if mode == WEBSITE:
        if selected != WEBSITE_MODEL:
            raise LoginError('login_model_unavailable', 'This ChatGPT website model is unavailable. Refresh the model list.', 409)
        if image:
            raise LoginError('login_image_unsupported',
                'The ChatGPT website connection cannot receive page images. Turn off Page image to AI.', 400)
        chat = remote.get('chat', '')
        if chat and not re.fullmatch(r'wc_[a-f0-9]{32}', chat):
            raise invalid('The retained ChatGPT conversation is invalid.')
        result = relay_webchat(WEBSITE_RELAY, {'action': 'turn', 'account': credentials['account'],
                                               'chat': chat, 'prompt': prompt + WEBSITE_REPLY_FORMAT}, check, dispatch=dispatch)
        text, handle = result.get('text'), result.get('chat')
        if not isinstance(text, str) or not text.strip() or not isinstance(handle, str) or \
                not re.fullmatch(r'wc_[a-f0-9]{32}', handle) or (chat and handle != chat):
            raise invalid('ChatGPT did not confirm a complete answer.')
        check()
        remote.update(chat=handle)
        return {'text': text, 'completed': True, 'statuses': [200], 'terminal': 'chatgpt_website_reply_finished'}
    if not isinstance(selected, str) or not 1 <= len(selected) <= 128 or any(ord(c) < 33 or ord(c) > 126 for c in selected):
        raise LoginError('login_model_unavailable', 'This ChatGPT model is unavailable.', 409)
    history = remote.get('input', [])
    if remote and (remote.get('model') != selected or not isinstance(history, list)):
        raise LoginError('login_chat_context_changed', 'The ChatGPT conversation context changed. Start a new run.', 409)
    if len(history) >= MAX_HISTORY_TURNS * 2 or _history_chars(history) + len(prompt) > MAX_HISTORY_CHARS:
        raise LoginError('login_chat_context_changed', 'This ChatGPT conversation is too long. Start a new run.', 409)
    content = [{'type': 'input_text', 'text': prompt}]
    if image:
        import base64
        data, mime = image
        content.append({'type': 'input_image', 'image_url': 'data:' + mime + ';base64,' + base64.b64encode(data).decode('ascii')})
    turn = {'role': 'user', 'content': content}
    body = {'model': selected, 'input': history + [turn], 'store': False, 'stream': True}
    with EndpointHTTP(OFFICIAL_RELAY, {}, check) as http:
        raw = http.request('/v1/responses', method='POST', body=body, headers={'Accept': 'text/event-stream'},
                           expected='text', dispatch=dispatch)
        text, usage = parse_responses(raw)
        if not text.strip():
            raise invalid('ChatGPT returned an empty answer.')
        check()
        # Keep text only; a page image is sent once and not repeated in later turns.
        remote.update(model=selected, input=history + [
            {'role': 'user', 'content': [{'type': 'input_text', 'text': prompt}]},
            {'role': 'assistant', 'content': [{'type': 'output_text', 'text': text}]}])
        return {'text': text, 'completed': True, 'statuses': http.statuses,
                'terminal': 'chatgpt_response_completed', **({'usage': usage} if usage else {})}


def validate_credentials(value):
    """Import shape from the extension: no token, password or cookie is accepted."""
    if isinstance(value, dict) and ('access_token' in value or 'device_id' in value):
        raise LoginError('login_reconnect_required', 'Update the extension and API together, then connect ChatGPT again.', 401)
    if not isinstance(value, dict) or value.keys() != {'mode', 'account', 'plan'} or \
            value['mode'] not in (OFFICIAL, WEBSITE) or not isinstance(value['account'], str) or \
            not ACCOUNT.fullmatch(value['account']) or not isinstance(value['plan'], str) or not PLAN.fullmatch(value['plan']):
        raise LoginError('login_credentials_invalid', 'The ChatGPT connection fields are invalid.', 400)
    return dict(value)

