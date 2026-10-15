"""Gemini consumer form protocol and UTF-16 length frames; no browser generation."""
import json
import re
import secrets
import uuid
from .login_provider_contract import LoginProvider, LoginError
from .endpoint.login_endpoint_http import EndpointHTTP, invalid, model
PROVIDER = LoginProvider('login_gemini', 'Gemini', 'web_endpoint', 'gemini.google.com', '/app', 0, '')
DEFAULT_METADATA = ['', '', '', None, None, None, None, None, None, '']
MAX_CONTEXT_CHARS = 65536
# Page images: the consumer upload host used by the website (reference:
# HanaokaYuzu/Gemini-API upload_file). The upload carries no Google cookie.
ENDPOINT_IMAGES = True
UPLOAD_URL = 'https://content-push.googleapis.com/upload'
UPLOAD_HEADERS = {'Push-ID': 'feeds/mcudyrk2a4khkz', 'X-Tenant-Id': 'bard-storage'}
EXTENSIONS = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp'}

def web_model():
    row = model('web-default', 'Gemini consumer default · Provider chooses the model')
    row['model_capabilities']['vision'] = {'supported': True, 'source': 'gemini_web_upload'}
    return row

def endpoint_model_rows(rows):
    return [web_model() if isinstance(row, dict) and row.get('id') == 'web-default' else row for row in rows]

def upload_image(http, image):
    data, mime = image
    name = 'page.' + EXTENSIONS[mime]
    path = http.upload(UPLOAD_URL, filename=name, data=data, mime=mime, headers=UPLOAD_HEADERS).strip()
    if not re.fullmatch(r'/contrib_service/[A-Za-z0-9_./=-]{1,2000}', path):
        raise invalid('Gemini did not return an uploaded image reference.', 'image_upload_invalid')
    return [[[path], name]]

def field(html, name):
    match = re.search(r'"' + re.escape(name) + r'"\s*:\s*("(?:[^"\\]|\\.)*")', html)
    if not match:
        raise LoginError('login_endpoint_bootstrap_invalid', 'Gemini did not expose the required signed-in session fields.', 409)
    value = json.loads(match[1])
    if not value or len(value) > 8192:
        raise invalid()
    return value

def headers(credentials):
    cookie = '__Secure-1PSID=' + credentials['psid']
    if credentials.get('psidts'):
        cookie += '; __Secure-1PSIDTS=' + credentials['psidts']
    return {'Cookie': cookie, 'X-Goog-AuthUser': credentials.get('auth_user', '0'), 'X-Same-Domain': '1'}

def bootstrap(http, credentials):
    user = credentials.get('auth_user', '0')
    if not re.fullmatch(r'[0-9]{1,2}', user):
        raise LoginError('login_credentials_invalid', 'Invalid Gemini account selection.', 400)
    raw = http.request('/app' if user == '0' else '/u/' + user + '/app', expected='text')
    try:
        html = raw.decode('utf-8')
        identity = field(html, 'oPEP7c').strip().lower()
        if not re.fullmatch(r'[^\s@]+@[^\s@]+', identity):
            raise invalid()
        return {'identity': identity, 'at': field(html, 'SNlM0e'),
                'bl': field(html, 'cfb2h'), 'sid': field(html, 'FdrFJe')}
    except UnicodeError:
        raise invalid() from None

def endpoint_validate(credentials, check):
    with EndpointHTTP(PROVIDER.id, headers(credentials), check) as http:
        boot = bootstrap(http, credentials)
        return {'identity': boot['identity'], 'credentials': {**credentials, 'identity': boot['identity']},
                'models': [web_model()]}

def frames(raw):
    try:
        text = raw.decode('utf-8')
        if not text.startswith(")]}'"):
            raise ValueError()
        cursor = 4
        while cursor < len(text):
            while cursor < len(text) and text[cursor] in '\r\n ': cursor += 1
            if cursor == len(text): break
            match = re.match(r'[0-9]{1,8}', text[cursor:])
            if not match: raise ValueError()
            count = int(match[0]); cursor += len(match[0])
            if not 0 < count <= 8 * 1024 * 1024 or cursor >= len(text) or text[cursor] != '\n':
                raise ValueError()
            begin, units = cursor, 0
            while cursor < len(text) and units < count:
                units += 2 if ord(text[cursor]) > 0xFFFF else 1
                cursor += 1
            if units != count: raise ValueError()
            yield json.loads(text[begin:cursor])
    except (UnicodeError, ValueError, TypeError):
        raise invalid('Gemini returned an incomplete or invalid length frame.') from None

def parse_reply(raw, conversation='', previous_metadata=None):
    text, candidate_id, ended = '', '', False
    metadata = list(DEFAULT_METADATA)
    if previous_metadata is not None:
        if not isinstance(previous_metadata, list) or len(previous_metadata) != 10:
            raise invalid('Gemini returned invalid conversation metadata.')
        metadata = list(previous_metadata)
    owning_conversation = conversation
    # Metadata-only preambles may precede the current answer. Pin the first
    # candidate's reply ID so later frames cannot replace its parent with
    # another reply from the same conversation.
    owning_reply = ''
    for frame in frames(raw):
        if not isinstance(frame, list): raise invalid()
        for record in frame:
            if not isinstance(record, list) or not record: raise invalid()
            if record[0] in ('di', 'af.httprm', 'e'): continue
            if record[0] == 'wrb.fr' and len(record) >= 6 and record[2] is None:
                terminal = [13, None, [['type.googleapis.com/assistant.boq.bard.application.BardErrorInfo', [1096]]]]
                # This closing code also occurs on rejected empty responses.
                # It succeeds only after a scoped, completed answer candidate.
                if ended and record[5] == terminal:
                    continue
                raise invalid('Gemini returned an unconfirmed terminal response.')
            if record[0] != 'wrb.fr' or len(record) < 3 or not isinstance(record[2], str):
                raise invalid()
            try: body = json.loads(record[2])
            except (ValueError, TypeError): raise invalid() from None
            if not isinstance(body, list): raise invalid()
            incoming = body[1] if len(body) > 1 else None
            if incoming is not None and incoming != []:
                if not isinstance(incoming, list) or not 2 <= len(incoming) <= 10 or any(
                        value is not None and (not isinstance(value, str) or len(value) > MAX_CONTEXT_CHARS)
                        for value in incoming):
                    raise invalid('Gemini returned invalid conversation metadata.')
                if incoming[0] is not None:
                    if not incoming[0].strip() or (owning_conversation and incoming[0] != owning_conversation):
                        raise invalid('Gemini changed the owning conversation.')
                    owning_conversation = incoming[0]
                if incoming[1] is not None:
                    if not incoming[1].strip():
                        raise invalid('Gemini returned an invalid owning reply.')
                    if owning_reply and incoming[1] != owning_reply:
                        raise invalid('Gemini changed the owning reply.')
                for index, value in enumerate(incoming):
                    if value is not None:
                        metadata[index] = value
            # Current replies can put the opaque continuation context on a
            # metadata-only final frame. Merge it without discarding the owning
            # conversation, reply and candidate IDs; it is not completion proof.
            context = body[25] if len(body) > 25 else None
            if context is not None:
                if not isinstance(context, str) or len(context) > MAX_CONTEXT_CHARS:
                    raise invalid('Gemini returned invalid continuation context.')
                metadata[9] = context
            if len(body) < 5 or not isinstance(body[4], list) or not body[4]:
                # Known metadata frames carry no candidate. Unknown errors stop.
                if 'BardErrorInfo' in record[2]: raise invalid()
                continue
            if ended: raise invalid('Gemini sent another answer after its terminal response.')
            candidate = body[4][0]
            if not isinstance(candidate, list) or len(candidate) < 9 or not isinstance(candidate[1], list) or not candidate[1] or not isinstance(candidate[1][0], str):
                raise invalid()
            if not isinstance(body[1], list) or len(body[1]) < 2 or not all(isinstance(x, str) and x for x in body[1][:2]):
                raise invalid()
            if owning_conversation and body[1][0] != owning_conversation: raise invalid('Gemini changed the owning conversation.')
            owning_conversation = body[1][0]
            owning_reply = body[1][1]
            text, candidate_id = candidate[1][0], candidate[0]
            ended = isinstance(candidate[8], list) and bool(candidate[8]) and candidate[8][0] == 2
    if not ended or not text.strip() or not isinstance(candidate_id, str) or not candidate_id:
        raise invalid('Gemini did not confirm a completed answer.')
    metadata[2] = candidate_id
    return text, metadata

def endpoint_generate(credentials, prompt, remote, selected, check, dispatch, image=None):
    if selected != 'web-default':
        raise LoginError('login_model_unavailable', 'This Gemini consumer model is unavailable.', 409)
    with EndpointHTTP(PROVIDER.id, headers(credentials), check) as http:
        boot = bootstrap(http, credentials)
        if boot['identity'] != credentials['identity']:
            raise LoginError('login_account_changed', 'The Gemini account changed. Reconnect.', 401)
        # The website client's request fields and a fresh correlation ID, not
        # browser attestation.
        request_id = str(uuid.uuid4()).upper()
        attached = upload_image(http, image) if image else None
        inner = [None] * 81
        for index, value in {0:[prompt,0,None,attached,None,None,0], 1:['en'],
                2:remote.get('metadata', list(DEFAULT_METADATA)),
                6:[1],7:1,10:1,11:0,17:[[0]],18:0,27:1,30:[4],41:[1],
                53:0,59:request_id,61:[],68:1,79:1,80:1}.items():
            inner[index] = value
        raw = http.request('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
            method='POST', form={'at': boot['at'], 'f.req': json.dumps([None,json.dumps(inner,ensure_ascii=False)],ensure_ascii=False)},
            params={'bl':boot['bl'],'f.sid':boot['sid'],'hl':'en','_reqid':str(secrets.randbelow(900000)+100000),'rt':'c','authuser':credentials.get('auth_user','0')},
            headers={'x-goog-ext-525005358-jspb': json.dumps([request_id,1], separators=(',', ':'))},
            expected='raw', dispatch=dispatch)
        text, metadata = parse_reply(raw, remote.get('metadata',[''])[0], remote.get('metadata'))
        remote.update(metadata=metadata, turn=remote.get('turn',0)+1)
        return {'text':text,'completed':True,'statuses':http.statuses,'terminal':'gemini_candidate_state_complete'}
