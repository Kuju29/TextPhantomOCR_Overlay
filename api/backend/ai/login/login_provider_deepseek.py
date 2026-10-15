"""DeepSeek consumer endpoints, ordinary server PoW and strict final-answer SSE."""
import base64
import json
import re
import time
import math
from .login_provider_contract import LoginProvider, LoginError
from .endpoint.login_endpoint_http import EndpointHTTP, identifier, invalid, model, sse
from .endpoint.login_provider_deepseek_hash import deepseek_hash_v1, DeepSeekNonceSearch
from . import login_observability as diagnostic
PROVIDER = LoginProvider('login_deepseek', 'DeepSeek', 'web_endpoint', 'chat.deepseek.com', '/', 0, '')

def headers(credentials):
    value = {'Authorization': 'Bearer ' + credentials['token']}
    if credentials.get('session_id'): value['Cookie'] = 'ds_session_id=' + credentials['session_id']
    return value

def business(value):
    if not isinstance(value, dict) or type(value.get('code')) is not int:
        raise invalid('DeepSeek returned an unknown consumer response envelope.', 'deepseek_envelope_invalid')
    if value['code'] != 0:
        error = LoginError('login_endpoint_rejected', 'DeepSeek rejected this consumer endpoint request.', 409)
        error.provider_reason = 'deepseek_endpoint_rejected'
        raise error
    if not isinstance(value.get('data'), dict):
        raise invalid('DeepSeek returned an unknown consumer response envelope.', 'deepseek_envelope_invalid')
    data = value['data']
    if type(data.get('biz_code')) is not int:
        raise invalid('DeepSeek omitted the consumer result status.', 'deepseek_business_status_missing')
    if data['biz_code'] != 0:
        # Provider business messages may contain personal or credential data.
        error = LoginError('login_endpoint_rejected', 'DeepSeek rejected this consumer account request.', 409)
        error.provider_reason = 'deepseek_business_rejected'
        raise error
    if not isinstance(data.get('biz_data'), dict):
        raise invalid('DeepSeek returned an unknown consumer result payload.', 'deepseek_business_data_invalid')
    return data['biz_data']

def session_id(created):
    # Maintained clients document both the direct and nested consumer variants.
    # Accept only these positions, with identical strict ID validation; never
    # guess an ID from another response field or choose between conflicting IDs.
    values = []
    if isinstance(created, dict):
        if 'id' in created:
            values.append(created['id'])
        if 'chat_session' in created:
            chat_session = created['chat_session']
            if not isinstance(chat_session, dict):
                raise invalid('DeepSeek returned an invalid conversation record. This turn was not sent.', 'deepseek_session_id_invalid')
            values.append(chat_session.get('id'))
    if not values:
        raise invalid('DeepSeek did not return a created conversation ID. This turn was not sent.', 'deepseek_session_id_missing')
    try:
        identifiers = [identifier(value) for value in values]
    except LoginError:
        raise invalid('DeepSeek returned an invalid conversation ID. This turn was not sent.', 'deepseek_session_id_invalid') from None
    if len(set(identifiers)) != 1:
        raise invalid('DeepSeek returned conflicting conversation IDs. This turn was not sent.', 'deepseek_session_id_conflict')
    return identifiers[0]

def endpoint_validate(credentials, check):
    with EndpointHTTP(PROVIDER.id, headers(credentials), check) as http:
        user = business(http.request('/api/v0/users/current'))
        identity = user.get('id')
        if isinstance(identity, int) and not isinstance(identity, bool): identity = str(identity)
        identity = identifier(identity)
        return {'identity':identity,'credentials':dict(credentials),
                'models':[deepseek_model()]}

# DeepSeek's chat request carries a DeepThink switch (thinking_enabled) and its
# reply separates THINK from RESPONSE fragments (parse_reply keeps only
# RESPONSE). That verified switch is offered as Thinking Off/On.
ENDPOINT_THINKING = True

def deepseek_model():
    row = model('web-default','DeepSeek consumer default')
    row['model_capabilities']['reasoning'] = {'supported': True, 'control': 'toggle', 'mandatory': False,
        'can_disable': True, 'supported_efforts': ['none', 'on'], 'app_controlled': True,
        'source': 'deepseek_web_thinking_enabled'}
    return row

def endpoint_model_rows(rows):
    return [deepseek_model() if isinstance(row, dict) and row.get('id') == 'web-default' else row for row in rows]

def thinking_enabled(thinking):
    # Lowest available / Off / unknown -> DeepThink off.
    return str(thinking or '').lower() in {'on', 'high', 'max', 'medium', 'low', 'minimal', 'xhigh'}

def proof(challenge, check):
    if not isinstance(challenge, dict) or challenge.get('algorithm') != 'DeepSeekHashV1' or \
            not isinstance(challenge.get('challenge'), str) or not re.fullmatch(r'[0-9a-fA-F]{64}', challenge['challenge']) or \
            not isinstance(challenge.get('salt'), str) or not 1 <= len(challenge['salt']) <= 512 or \
            not isinstance(challenge.get('signature'), str) or not 1 <= len(challenge['signature']) <= 4096 or \
            type(challenge.get('difficulty')) is not int or not 1 <= challenge['difficulty'] <= 200000 or \
            type(challenge.get('expire_at')) not in (int, float) or not math.isfinite(challenge['expire_at']):
        raise LoginError('login_pow_unsupported', 'DeepSeek returned an unsupported computation challenge.', 409)
    expires = challenge['expire_at']
    if expires > 10**12: expires /= 1000
    deadline = min(time.monotonic()+90, time.monotonic()+expires-time.time())
    target = bytes.fromhex(challenge['challenge'])
    prefix = (challenge['salt']+'_'+str(challenge['expire_at'])+'_').encode()
    def current():
        check()
        if time.monotonic() >= deadline:
            raise LoginError('login_pow_expired', 'DeepSeek computation challenge expired. Start a new run.', 409)
    current()
    search = DeepSeekNonceSearch(prefix, target)
    for start in range(0, challenge['difficulty'], search.BATCH_SIZE):
        current()
        nonce = search.find(start, min(start + search.BATCH_SIZE, challenge['difficulty']))
        current()
        if nonce is not None:
            # Independent scalar verification protects the wire contract from
            # vectorization/runtime errors; never send an unverified candidate.
            if type(nonce) is not int or not start <= nonce < min(start + search.BATCH_SIZE, challenge['difficulty']) or deepseek_hash_v1(prefix+str(nonce).encode()) != target:
                raise LoginError('login_pow_unsolved','DeepSeek computation challenge could not be verified.',409)
            current()
            return base64.b64encode(json.dumps({'algorithm':'DeepSeekHashV1','challenge':challenge['challenge'],
                'salt':challenge['salt'],'answer':nonce,'signature':challenge['signature'],
                'target_path':'/api/v0/chat/completion'},separators=(',',':')).encode()).decode()
    raise LoginError('login_pow_unsolved','DeepSeek computation challenge could not be completed.',409)

def parse_reply(raw, conversation=""):
    response, ready, closed, finished, path, operation = {}, None, False, False, '', 'SET'
    def update(data, parent=''):
        nonlocal path, operation
        if not isinstance(data, dict): raise invalid()
        if response.get('status') == 'FINISHED':
            raise invalid('DeepSeek changed its answer after the terminal response.')
        p = data.get('p', path)
        op = data.get('o', 'SET' if parent else operation)
        if not isinstance(p, str) or not isinstance(op, str): raise invalid()
        if parent and not p.startswith('response'): p = parent+'/'+p
        value = data.get('v')
        if op == 'BATCH':
            if not isinstance(value,list): raise invalid()
            for child in value: update(child,p)
            return
        path, operation = p, op
        if not p:
            if not isinstance(value,dict) or not isinstance(value.get('response'),dict): raise invalid()
            response.update(value['response'])
        elif p == 'response':
            if op != 'SET' or not isinstance(value,dict): raise invalid()
            response.clear(); response.update(value)
        elif p == 'response/fragments':
            if op == 'APPEND' and isinstance(value,list): response.setdefault('fragments',[]).extend(value)
            elif op == 'SET' and isinstance(value,list): response['fragments'] = value
            else: raise invalid()
        elif p.startswith('response/fragments/'):
            parts = p.split('/')
            try:
                if len(parts) != 4: raise ValueError()
                fragments = response['fragments']; index = int(parts[2]); fragment = fragments[index]
                if not isinstance(fragment,dict): raise ValueError()
                key = parts[3]
                if key == 'content' and (not isinstance(value,str) or not isinstance(fragment.get(key,''),str)): raise ValueError()
                if op == 'APPEND': fragment[key] = fragment.get(key,'')+value
                elif op == 'SET': fragment[key] = value
                else: raise ValueError()
            except (KeyError,IndexError,ValueError,TypeError): raise invalid() from None
        elif p.startswith('response/') and len(p.split('/')) == 2:
            if op != 'SET': raise invalid()
            response[p.split('/')[1]] = value
        else:
            raise invalid()
    for event, data in sse(raw):
        if not isinstance(data,dict) or closed: raise invalid()
        if finished and event not in ('close', 'title', 'update_session'):
            raise invalid('DeepSeek sent content after the terminal response.')
        bare_ready = not event and 'response_message_id' in data
        if event == 'ready' or bare_ready:
            if bare_ready and (response or not data.keys() <= {'request_message_id', 'response_message_id'}): raise invalid()
            if ready is not None or type(data.get('response_message_id')) is not int or data['response_message_id'] <= 0: raise invalid()
            if 'request_message_id' in data and (type(data['request_message_id']) is not int or data['request_message_id'] <= 0): raise invalid()
            ready = data['response_message_id']
        elif event == 'close': closed = True
        elif event in ('title','update_session'): continue
        elif event: raise invalid()
        else:
            update(data)
            # Older response variants put readiness in the initial assistant
            # record. Keep the parent chain pinned to a positive integer ID.
            if ready is None and 'message_id' in response:
                if type(response['message_id']) is not int or response['message_id'] <= 0: raise invalid()
                ready = response['message_id']
            finished = response.get('status') == 'FINISHED'
    if conversation and response.get('chat_session_id', conversation) != conversation:
        raise invalid('DeepSeek changed the owning conversation.')
    fragments = response.get('fragments',[])
    if not isinstance(fragments,list) or any(not isinstance(f,dict) or f.get('type') not in ('THINK','RESPONSE') or not isinstance(f.get('content'),str) for f in fragments): raise invalid()
    text = ''.join(f['content'] for f in fragments if f['type'] == 'RESPONSE')
    message_id = response.get('message_id', response.get('id', ready))
    # HTTP transport has already drained successfully and sse() rejects an
    # unfinished frame. FINISHED is the provider's terminal confirmation; some
    # consumer variants additionally send close, while older ones use clean EOF.
    if ready is None or not finished or not text.strip() or \
            response.get('role','ASSISTANT') != 'ASSISTANT' or type(message_id) is not int or message_id != ready:
        raise invalid('DeepSeek did not confirm a complete assistant answer.')
    return text, ready

def endpoint_generate(credentials,prompt,remote,selected,check,dispatch,thinking=None):
    if selected != 'web-default': raise LoginError('login_model_unavailable','This DeepSeek consumer model is unavailable.',409)
    with EndpointHTTP(PROVIDER.id,headers(credentials),check) as http:
        cid = remote.get('conversation')
        if not cid:
            created = business(http.request('/api/v0/chat_session/create',method='POST',body={}))
            cid = session_id(created)
        challenge = business(http.request('/api/v0/chat/create_pow_challenge',method='POST',body={'target_path':'/api/v0/chat/completion'})).get('challenge')
        diagnostic.stage('deepseek_pow_compute')
        answer = proof(challenge,check)
        diagnostic.stage('deepseek_pow_completed')
        raw = http.request('/api/v0/chat/completion',method='POST',body={
            'chat_session_id':cid,'parent_message_id':remote.get('parent'), 'prompt':prompt,
            'ref_file_ids':[],'thinking_enabled':thinking_enabled(thinking),'search_enabled':False},
            headers={'X-DS-PoW-Response':answer,'Accept':'text/event-stream'},dispatch=dispatch,expected='sse')
        text,parent = parse_reply(raw,cid)
        remote.update(conversation=cid,parent=parent)
        return {'text':text,'completed':True,'statuses':http.statuses,'terminal':'deepseek_finished_after_full_stream'}
