"""Claude consumer account validation and completion.

Every claude.ai request is sent by the extension from the customer's own
claude.ai tab (login_browser_relay); the API's own HTTPS client gets a
Cloudflare challenge. The API never holds the claude.ai session cookie;
credentials are only the selected organization id."""
import re
import uuid
from .login_provider_contract import LoginProvider, LoginError
from .endpoint.login_endpoint_http import EndpointHTTP, identifier, invalid, model, sse, provider_unavailable
PROVIDER = LoginProvider('login_claude', 'Claude', 'web_endpoint', 'claude.ai', '/new', 0, '')
# Page images: the website's own upload route, then the file id in the turn
# (reference: st1vms/unofficial-claude-api). Same origin and session cookie.
ENDPOINT_IMAGES = True
EXTENSIONS = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp'}

def website_model(mid):
    row = model(mid, mid + ' · Website model; access checked when sending')
    row['model_capabilities']['vision'] = {'supported': True, 'source': 'claude_web_upload'}
    return row

# claude.ai's chat picker (app_start model_selector_config, group "chat") says
# per model which AI think the website offers and whether this account's plan
# may use it. The completion body carries the chosen values ("effort",
# "thinking_mode"), exactly as the website sends them; the website's PATCH of
# model_selector_state is only its picker memory and is not sent.
# Evidence: docs/login-web-fields-10492.md.
ENDPOINT_THINKING = True
ENDPOINT_MODEL_ROW = True
CATALOGUE = 'model_selector_config'
THINKING_SOURCE = 'claude_web_model_selector_config'
CHAT_SECTIONS = ('main', 'overflow')
SITE_ID = re.compile(r'[a-z0-9_-]{1,32}')
BADGE = re.compile(r'[A-Za-z0-9 +&/.-]{1,40}')


def _option_ids(options):
    """The website's option ids, verbatim, in its order; None when malformed."""
    if not isinstance(options, list) or len(options) > 20:
        return None
    out = []
    for option in options:
        if not isinstance(option, dict) or not isinstance(option.get('id'), str) or not SITE_ID.fullmatch(option['id']):
            return None
        if option['id'] not in out:
            out.append(option['id'])
    return out


def website_thinking(value):
    """claude.ai ``thinking`` -> (reasoning record, send spec).

    ``(None, None)`` keeps the website-managed provider default (unknown or
    malformed shape)."""
    kind = value.get('type') if isinstance(value, dict) else None
    if kind == 'none':
        return {'supported': False, 'app_controlled': True, 'source': THINKING_SOURCE}, {'type': 'none'}
    if kind not in ('effort_and_mode', 'mode'):
        return None, None
    modes = _option_ids(value.get('mode_options', []))
    if modes is None:
        return None, None
    off = 'off' in modes
    # The non-off mode the website pairs with thinking (auto or extended).
    on_mode = next((mode for mode in modes if mode != 'off'), None)
    base = {'supported': True, 'mandatory': not off, 'can_disable': off, 'app_controlled': True,
            'source': THINKING_SOURCE}
    if kind == 'effort_and_mode':
        efforts = _option_ids(value.get('effort_options'))
        if not efforts:
            return None, None
        reasoning = {**base, 'control': 'levels', 'supported_efforts': (['none'] if off else []) + efforts}
        recommended = [row['id'] for row in value['effort_options'] if row.get('recommended') is True]
        if len(recommended) == 1:
            # What the website itself uses when TextPhantom sends no effort.
            reasoning['default_effort'] = recommended[0]
        return reasoning, {'type': kind, 'efforts': efforts, 'on_mode': on_mode, 'off': off}
    if on_mode is None:
        return None, None
    return ({**base, 'control': 'toggle', 'supported_efforts': (['none'] if off else []) + ['on']},
            {'type': kind, 'on_mode': on_mode, 'off': off})


def plan_access(item):
    """A disabled chat-picker model: not usable on this account (plan badge)."""
    if item.get('disabled') is not True:
        return None
    reason = item.get('disabled_reason') if isinstance(item.get('disabled_reason'), dict) else {}
    access = {'usable': False, 'reason': 'website_disabled', 'evidence': 'claude_model_selector_disabled'}
    if reason.get('type') == 'upgrade_required':
        access['reason'] = 'plan_required'
        plan = reason.get('required_plan')
        if isinstance(plan, str) and SITE_ID.fullmatch(plan):
            access['required_plan'] = plan
        badge = item.get('badge', {}).get('message') if isinstance(item.get('badge'), dict) else None
        if isinstance(badge, str) and BADGE.fullmatch(badge.strip()):
            access['badge'] = badge.strip()
    return access


def picker_model(item):
    """One chat-picker entry -> model row, or None when the picker hides it."""
    if not isinstance(item, dict) or item.get('section') not in CHAT_SECTIONS:
        return None  # deprecated (or unknown) sections are not offered
    mid = identifier(item.get('id'))
    name = item.get('name')
    row = model(mid, name.strip() if isinstance(name, str) and name.strip() and len(name) <= 160 else mid)
    row['model_capabilities']['vision'] = {'supported': True, 'source': 'claude_web_upload'}
    reasoning, spec = website_thinking(item.get('thinking'))
    if reasoning is not None:
        row['model_capabilities']['reasoning'] = reasoning
    row['_metadata'] = {'transport': 'web_endpoint', 'catalogue': CATALOGUE, 'thinking': spec}
    access = plan_access(item)
    if access:
        row['availability'] = access
    return row


def chat_picker(catalog):
    groups = catalog.get('model_selector_config')
    if not isinstance(groups, list):
        return None
    chat = [group for group in groups if isinstance(group, dict) and group.get('id') == 'chat']
    if len(chat) != 1 or not isinstance(chat[0].get('models'), list) or len(chat[0]['models']) > 100:
        return None
    return chat[0]['models']


def endpoint_model_rows(rows):
    # Rows saved before the chat-picker catalogue keep the website default.
    return [website_model(row['id']) if isinstance(row, dict) and isinstance(row.get('id'), str) and
            row.get('_metadata', {}).get('transport') == 'web_endpoint' and
            row['_metadata'].get('catalogue') != CATALOGUE else row for row in rows]


def thinking_fields(row, thinking):
    """Completion body fields for the chosen AI think, as claude.ai sends them."""
    value = str(thinking or 'default').strip().lower()
    if value == 'default':
        return {}  # the website's own default: no field
    spec = (row or {}).get('_metadata', {}).get('thinking') if isinstance(row, dict) else None
    kind = spec.get('type') if isinstance(spec, dict) else None
    if value == 'off' and kind in ('effort_and_mode', 'mode') and spec['off']:
        return {'thinking_mode': 'off'}
    if kind == 'effort_and_mode' and value in spec['efforts']:
        return {'effort': value, **({'thinking_mode': spec['on_mode']} if spec['on_mode'] else {})}
    if kind == 'mode' and value == 'on':
        return {'thinking_mode': spec['on_mode']}
    raise LoginError('ai_thinking_mode_unavailable',
        'claude.ai does not offer this AI think setting for the selected model. Choose another setting. Nothing was sent.', 409)

def upload_image(http, org, image):
    data, mime = image
    reply = http.request('/api/' + org + '/upload', method='POST', form={'orgUuid': org},
        files={'file': ('page.' + EXTENSIONS[mime], data, mime)}, headers={'Accept': 'application/json'})
    if not isinstance(reply, dict):
        raise invalid('Claude did not return an uploaded image reference.', 'image_upload_invalid')
    return identifier(reply.get('file_uuid'))

def selected_organization(credentials):
    if not isinstance(credentials, dict) or 'organization' not in credentials:
        raise LoginError('login_reconnect_required',
            'Reconnect Claude so its selected organization can be verified.', 401)
    return identifier(credentials['organization'])


def authenticated_identity(http, org_id):
    data = http.request('/api/bootstrap')
    if not isinstance(data, dict) or not isinstance(data.get('account'), dict):
        raise invalid('Claude did not return a verified consumer account.')
    account = data['account']
    account_id = identifier(account.get('uuid'))
    current_org = account.get('lastActiveOrgId')
    if current_org is not None and identifier(current_org) != org_id:
        raise LoginError('login_account_changed',
            'The selected Claude organization changed during Login. Select it again and reconnect.', 409)
    orgs = http.request('/api/organizations')
    if not isinstance(orgs, list):
        raise invalid()
    ids = {identifier(org['uuid']) for org in orgs if isinstance(org, dict) and org.get('uuid')}
    if org_id not in ids:
        raise LoginError('login_organization_required', 'Select your Claude organization on the provider website and reconnect.', 409)
    return account_id + '\0' + org_id


def endpoint_authenticate(credentials, check):
    """Verify account and captured membership only, without a model grant."""
    org_id = selected_organization(credentials)
    with EndpointHTTP(PROVIDER.id, {}, check) as http:
        identity = authenticated_identity(http, org_id)
        return {'identity': identity, 'credentials': {**credentials, 'organization': org_id},
                'models': [], 'authentication_only': True}


def endpoint_validate(credentials, check):
    org_id = selected_organization(credentials)
    with EndpointHTTP(PROVIDER.id, {}, check) as http:
        identity = authenticated_identity(http, org_id)
        catalog = http.request('/edge-api/bootstrap/' + identifier(org_id) + '/app_start',
            params={'statsig_hashing_algorithm': 'djb2', 'growthbook_format': 'sdk',
                    'cache_bust': '1', 'include_system_prompts': 'false'})
        if not isinstance(catalog, dict) or not isinstance(catalog.get('claude_ai_available_models'), dict):
            raise invalid('Claude did not return a consumer model catalogue.')
        entries = catalog['claude_ai_available_models'].get('models', [])
        if not isinstance(entries, list) or not entries or len(entries) > 100:
            raise invalid('Claude did not return a consumer model catalogue.')
        rows, known = [], set()
        # The chat picker first: its models, AI think and plan access.
        for item in chat_picker(catalog) or []:
            if isinstance(item, dict):
                known.add(identifier(item.get('id')))
            row = picker_model(item)
            if row and not any(other['id'] == row['id'] for other in rows):
                rows.append(row)
        # Only ids the picker does not describe fall back to the plain list
        # (access checked when sending; a 403 is remembered).
        for item in entries:
            if not isinstance(item, dict):
                raise invalid('Claude did not return a consumer model catalogue.')
            mid = identifier(item.get('model_id'))
            if mid not in known and not any(row['id'] == mid for row in rows):
                rows.append(website_model(mid))
        if not rows or len(rows) > 100:
            raise invalid('Claude did not return a usable model catalogue.')
        return {'identity': identity, 'credentials': {**credentials, 'organization': org_id}, 'models': rows}

def parse_reply(raw, *, expected_conversation=None, return_parent=False):
    blocks, started, ended, reason, parent = {}, False, False, None, None

    def stop_reason(value):
        nonlocal reason
        if value is None:
            return
        if not isinstance(value, str) or not value or (reason is not None and reason != value):
            raise invalid('Claude sent conflicting terminal response metadata.')
        reason = value

    def message_metadata(message, *, required=False):
        nonlocal parent
        if not isinstance(message, dict) or (required and message.get('role') != 'assistant') or \
                ('role' in message and message['role'] != 'assistant'):
            raise invalid()
        if required or 'uuid' in message:
            mid = identifier(message.get('uuid'))
            if parent is not None and parent != mid:
                raise invalid('Claude sent conflicting assistant message identities.')
            parent = mid
        # Some web stream variants include their conversation in the message.
        # Validate supplied ownership fields; never treat them as a new run.
        conversation = None
        for key in ('conversation_uuid', 'conversation_id'):
            if key in message:
                value = identifier(message[key])
                if conversation is not None and conversation != value or \
                        expected_conversation is not None and expected_conversation != value:
                    raise invalid('Claude sent a reply for a different conversation.')
                conversation = value
        stop_reason(message.get('stop_reason'))

    for event, data in sse(raw):
        if not isinstance(data, dict):
            raise invalid()
        kind = data.get('type', event)
        if event and event != kind:
            raise invalid()
        if kind in ('ping', 'message_limit'):
            continue
        # claude.ai may announce the new conversation before the message; it
        # carries no answer content.
        if kind == 'conversation_ready' and not started and not ended:
            continue
        if ended:
            raise invalid('Claude sent content after its terminal response.')
        if kind == 'error':
            # Anthropic's documented stream error types for its own server
            # failures: overloaded_error (temporarily overloaded) and api_error
            # (internal error). Anything else stays a rejection.
            detail = data.get('error') if isinstance(data.get('error'), dict) else {}
            if detail.get('type') in ('overloaded_error', 'api_error'):
                raise provider_unavailable('login_claude', 'provider_overloaded' if detail['type'] == 'overloaded_error' else 'provider_server_error')
            raise LoginError('login_endpoint_rejected', 'Claude rejected this consumer chat turn.', 502)
        if kind == 'message_start':
            message = data.get('message')
            if started or blocks:
                raise invalid()
            message_metadata(message, required=True)
            started = True
        elif kind in ('ping', 'message_limit'):
            continue
        elif not started:
            raise invalid()
        elif kind == 'content_block_start':
            index, block = data.get('index'), data.get('content_block', {})
            if type(index) is not int or index < 0 or index in blocks or not isinstance(block, dict):
                raise invalid()
            if block.get('type') not in ('text', 'thinking', 'redacted_thinking') or not isinstance(block.get('text', ''), str):
                raise invalid()
            blocks[index] = {'kind': block.get('type'), 'text': block.get('text', '') if block.get('type') == 'text' else '', 'closed': False}
        elif kind == 'content_block_delta':
            index, delta = data.get('index'), data.get('delta', {})
            if type(index) is not int or index not in blocks or blocks[index]['closed'] or not isinstance(delta, dict):
                raise invalid()
            if delta.get('type') == 'text_delta':
                if blocks[index]['kind'] != 'text' or not isinstance(delta.get('text'), str):
                    raise invalid()
                blocks[index]['text'] += delta['text']
            elif delta.get('type') not in ('thinking_delta', 'signature_delta', 'thinking_summary_delta') or blocks[index]['kind'] != 'thinking':
                raise invalid()
        elif kind == 'content_block_stop':
            if type(data.get('index')) is not int or data['index'] not in blocks or blocks[data['index']]['closed']:
                raise invalid()
            blocks[data['index']]['closed'] = True
        elif kind == 'message_delta':
            if not isinstance(data.get('delta'), dict) or any(not block['closed'] for block in blocks.values()):
                raise invalid()
            stop_reason(data['delta'].get('stop_reason'))
        elif kind == 'message_stop':
            if 'message' in data:
                message_metadata(data['message'])
            stop_reason(data.get('stop_reason'))
            ended = True
        elif kind not in ('message_start', 'ping'):
            raise invalid()
    text = ''.join(blocks[index]['text'] for index in sorted(blocks))
    if not ended or parent is None or reason != 'end_turn' or not text.strip() or any(not block['closed'] for block in blocks.values()):
        raise invalid('Claude did not confirm a complete text answer.')
    return (text, parent) if return_parent else text

def endpoint_generate(credentials, prompt, remote, selected, check, dispatch, image=None,
                      thinking='default', model_row=None):
    org = identifier(credentials['organization'])
    selected = identifier(selected)
    if not isinstance(remote, dict):
        raise invalid('The retained Claude conversation is invalid.')
    if model_row is not None and (not isinstance(model_row, dict) or model_row.get('id') != selected):
        raise invalid('The Claude model record does not match the selected model.')
    chosen = thinking_fields(model_row, thinking)
    first = not remote
    cid = str(uuid.uuid4()) if first else identifier(remote.get('conversation'))
    parent = None if first else identifier(remote.get('parent'))
    human, assistant = str(uuid.uuid4()), str(uuid.uuid4())
    payload = {'prompt': prompt, 'model': selected, 'timezone': 'UTC', 'locale': 'en-US',
        'tools': [], 'attachments': [], 'files': [], 'sync_sources': [],
        'turn_message_uuids': {'human_message_uuid': human, 'assistant_message_uuid': assistant},
        'rendering_mode': 'messages', **chosen}
    if first:
        payload['create_conversation_params'] = {'name': '', 'model': selected,
            'include_conversation_preferences': True, 'paprika_mode': None, 'compass_mode': None,
            'is_temporary': False, 'enabled_imagine': False, 'tool_search_mode': 'auto'}
    else:
        payload['parent_message_uuid'] = parent
    with EndpointHTTP(PROVIDER.id, {'Accept': 'text/event-stream'}, check) as http:
        if image:
            payload['files'] = [upload_image(http, org, image)]
        raw = http.request('/api/organizations/' + org + '/chat_conversations/' + identifier(cid) + '/completion',
            method='POST', body=payload, headers={'Accept': 'text/event-stream'}, expected='sse', dispatch=dispatch)
        text, parent = parse_reply(raw, expected_conversation=cid, return_parent=True)
        check()
        remote.update(conversation=cid, parent=parent)
        return {'text': text, 'completed': True, 'statuses': http.statuses,
                'terminal': 'claude_message_stop_end_turn',
                'thinking_applied': ('requested_' + str(thinking).lower()) if chosen else 'provider_default'}
