"""Experimental native adapter through real API routes with synthetic upstream HTTP.

No provider credential, browser account, or live ChatGPT generation is used.
This suite explicitly overrides the public unsupported-translation gate inside
its own process, so it can continue testing the inactive native protocol. The
normal public gate is covered by test-login-public-capabilities-10445.py.
Run with --http in an environment permitted to create asyncio loopback sockets.
"""
from pathlib import Path
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, ExitStack
from dataclasses import replace
import hashlib
import json
import os
import re
import sys
import tempfile
import threading
import time
import traceback
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
import httpx
from fastapi import FastAPI
# A Login-enabled API is configured with a Center before its composition root
# runs. Mirror that production startup order, entirely within this QA process.
os.environ['TP_CENTER_URL'] = 'https://center.fixture.invalid'
from backend.config import settings
from backend import paid_center
from backend.ai.provider_bootstrap import ensure_provider_registry
ensure_provider_registry()
from backend.ai.login import login_routes, login_session_store, login_observability, login_translation
from backend.ai.login.endpoint import login_endpoint_session, login_endpoint_runs
from backend.ai.login.login_provider_contract import LoginError
from backend.api.routes import ai_v1, repair_runs
from backend.application.repair_pool.store import RepairStore
from backend.application.repair_pool import state as repair_state
from backend.application import idempotency
from backend.application.ai_translation import provider_execution
from backend.ai.translation_paths import store as conversation_store

RUN_HTTP = '--http' in sys.argv
if RUN_HTTP:
    sys.argv.remove('--http')

# Intentionally synthetic values; assertion messages never serialize credentials.
BEARERS = {'a' * 64: 'tp-owner-a', 'b' * 64: 'tp-owner-b'}
ACCESS = 'synthetic-chatgpt-access-never-a-live-token'
ACCOUNT = 'fixture_workspace_a'
USER = 'fixture_provider_user_a'
DEVICE = 'fixture_device_a'
ACCESS_B, ACCOUNT_B, USER_B = ACCESS + '-second-owner', 'fixture_workspace_b', 'fixture_provider_user_b'
CID = '11111111-2222-4333-8444-555555555555'
PREPARATION = 'synthetic-requirements-material-never-live'
RUN_TOKEN = 'c' * 64


def sse(data, kind=''):
    return ((f'event: {kind}\n' if kind else '') + 'data: ' +
            (data if isinstance(data, str) else json.dumps(data)) + '\n\n').encode()


class ProviderFixture:
    """Observe the actual native request body, authorization and terminal stream."""
    def __init__(self):
        self.calls, self.generations = [], []
        self.user, self.proof, self.stream_error = USER, False, False
        self.incomplete, self.wrong_conversation = False, False
        self.block_stream, self.entered, self.release = False, threading.Event(), threading.Event()
        self.prepare_count = 0

    def __call__(self, request):
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, request.url.host, request.url.path, body))
        if request.url.host in ('center.fixture.invalid', 'other-center.fixture.invalid'):
            owner = BEARERS.get(request.headers.get('authorization', '')[7:])
            return httpx.Response(200 if owner else 401, json={'ok': bool(owner),
                'user_id': owner, 'active': bool(owner), 'entitlement': {'status': 'active'}})
        if request.url.scheme != 'https' or request.url.host != 'chatgpt.com':
            raise AssertionError('Provider traffic escaped its fixed HTTPS origin')
        token = request.headers.get('authorization', '')[7:]
        expected_account = ACCOUNT if token == ACCESS else ACCOUNT_B
        if token not in (ACCESS, ACCESS_B):
            raise AssertionError('Wrong account token reached the provider')
        if request.headers.get('chatgpt-account-id') != expected_account:
            raise AssertionError('Wrong workspace reached the provider')
        if request.headers.get('origin') or request.headers.get('referer'):
            raise AssertionError('Python native adapter fabricated browser headers')
        if request.url.path == '/backend-api/me':
            user = self.user if self.user != USER else USER if token == ACCESS else USER_B
            return httpx.Response(200, json={'id': user,
                'email': 'private-fixture-email@example.invalid', 'name': 'Private fixture name'})
        if request.url.path == '/backend-api/models':
            return httpx.Response(200, json={'models': [
                {'slug': 'fixture-model', 'title': 'Fixture model', 'tags': []},
                {'slug': 'hidden-fixture-model', 'title': 'Hidden', 'tags': ['hidden']}],
                'default_model_slug': 'fixture-model'})
        if request.url.path == '/backend-api/sentinel/chat-requirements/prepare':
            if body != {}:
                raise AssertionError('Native preflight must send the honest empty object')
            self.prepare_count += 1
            return httpx.Response(200, json={'token': PREPARATION + str(self.prepare_count),
                'proofofwork': {'required': self.proof}, 'turnstile': {'required': False}})
        if request.url.path != '/backend-api/f/conversation':
            raise AssertionError('Unexpected upstream endpoint')
        if request.headers.get('openai-sentinel-chat-requirements-token') != PREPARATION + str(self.prepare_count):
            raise AssertionError('Generation must consume its own fresh native preparation')
        if any('proof' in key or 'turnstile' in key or 'arkose' in key for key in request.headers):
            raise AssertionError('Native-only flow must not fabricate provider challenge answers')
        self.generations.append({'body': body, 'headers': dict(request.headers)})
        prompt = body['messages'][0]['content']['parts'][0]
        ids = [uid for uid in ('I10_P0', 'I11_P0', 'I12_P0', 'I20_P0') if '<<' + uid + ':' in prompt]
        if not ids:
            raise AssertionError('Original production source record was lost')
        assistant = 'aaaaaaaa-bbbb-4ccc-8ddd-' + f'{len(self.generations):012d}'
        snapshot = {'conversation_id': CID if not self.wrong_conversation else 'foreign-conversation',
            'message': {'id': assistant, 'author': {'role': 'assistant'}, 'channel': 'final',
                'recipient': 'all', 'status': 'finished_successfully', 'end_turn': True,
                'content': {'content_type': 'text', 'parts': [f'<<{ids[-1]}:ทดสอบ>>']},
                'metadata': {}}}
        raw = sse(snapshot)
        if self.stream_error:
            raw += sse({'message': ACCESS + PREPARATION + USER + ACCOUNT}, 'error')
        if not self.incomplete:
            raw += sse('[DONE]')
        if self.block_stream:
            fixture = self
            class PausedStream(httpx.SyncByteStream):
                def __iter__(self):
                    fixture.entered.set()
                    if not fixture.release.wait(10):
                        raise httpx.ReadTimeout('Synthetic stream gate expired')
                    yield raw
                def close(self):
                    fixture.release.set()
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=PausedStream())
        return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=raw)


@unittest.skipUnless(RUN_HTTP, 'Pass --http to run the actual ASGI HTTP route suite')
class ChatGPTProductionHttp(unittest.TestCase):
    def setUp(self):
        login_session_store.clear(); login_endpoint_session.clear(); login_endpoint_runs.clear()
        idempotency.clear()
        conversation_store._stores.clear()
        self.fixture, self.observed, self.exceptions = ProviderFixture(), [], []
        self.tmp = tempfile.TemporaryDirectory(prefix='tp-chatgpt-http-10441-')
        self.stack = ExitStack()
        # TEST ONLY: the production public capability remains unsupported.
        self.stack.enter_context(patch.object(login_translation,
            'require_translation_supported', return_value=None))
        self.stack.enter_context(patch.object(login_translation,
            'translation_supported', return_value=True))
        # Exercise the full internal endpoint contract rather than the public
        # authentication-only path for providers still under improvement.
        self.stack.enter_context(patch('backend.ai.login.login_provider_registry.translation_supported', return_value=True))
        self.stack.enter_context(patch.object(paid_center, 'settings', replace(settings,
            center_url='https://center.fixture.invalid')))
        self.stack.enter_context(patch.dict('os.environ', {'TP_LOGIN_ENABLED_PROVIDERS': 'login_chatgpt',
            'TP_LOGIN_ENDPOINT_MIN_INTERVAL_MS': '0', 'TP_AI_WIRE_TRACE': '1',
            'TP_AI_WIRE_TRACE_DIR': self.tmp.name}))
        self.stack.enter_context(patch.object(repair_runs, 'store', RepairStore()))
        original_client = httpx.Client
        def make_client(*args, **kwargs):
            kwargs['transport'] = httpx.MockTransport(self.fixture)
            return original_client(*args, **kwargs)
        self.stack.enter_context(patch.object(httpx, 'Client', side_effect=make_client))
        actual_translate = provider_execution.translate
        def observed_translate(*args, **kwargs):
            try:
                return actual_translate(*args, **kwargs)
            except BaseException as error:
                # Stack frame names/locations only; no exception repr, source
                # lines, provider bodies, request values or traceback locals.
                self.exceptions.append({'class': type(error).__name__, 'frames': [
                    {'file': Path(frame.filename).name, 'function': frame.name, 'line': frame.lineno}
                    for frame in traceback.extract_tb(error.__traceback__)]})
                raise
        self.stack.enter_context(patch.object(provider_execution, 'translate', side_effect=observed_translate))
        for module, name in ((login_observability, 'log_event'),):
            self.stack.enter_context(patch.object(module, name,
                side_effect=lambda *args, **kwargs: self.observed.append((args, kwargs))))
        self.app = FastAPI()
        self.app.include_router(login_routes.router)
        self.app.include_router(ai_v1.router)
        self.app.include_router(repair_runs.router)
        # The production main.py LoginError handler contract, without starting
        # unrelated Lens runtimes or a localhost service in this route fixture.
        @self.app.exception_handler(LoginError)
        async def login_error(request, error):
            with login_observability.context(operation='inference'):
                response = login_routes.failure_response(error, request)
                body = json.loads(response.body)
                body['detail'] = {**body['error'], 'userMessage': str(error),
                    'providerAttempts': int(error.requestDispatched),
                    'generationAttempts': int(error.requestDispatched)}
                response.body = json.dumps(body).encode()
                response.headers['content-length'] = str(len(response.body))
                return response
        class Gate:
            @asynccontextmanager
            async def slot(self, _):
                yield
        self.app.state.ai_admission_gate = Gate()
        self.executor = ThreadPoolExecutor(max_workers=3)
        self.app.state.ai_executor = self.executor

    def tearDown(self):
        self.fixture.release.set()
        self.executor.shutdown(wait=True)
        self.stack.close()
        login_endpoint_runs.clear(); login_endpoint_session.clear(); login_session_store.clear()
        self.tmp.cleanup()

    def client(self, bearer='a' * 64):
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
            base_url='http://api.fixture.invalid', headers={'Authorization': 'Bearer ' + bearer,
                'X-TP-Run-Token': RUN_TOKEN, 'X-TP-Tab-Session': 'owned-tab-10441'})

    def assert_status(self, response, status=200):
        # Do not put raw response/request bodies or credential values in logs.
        self.assertEqual(response.status_code, status,
            f'Unexpected route status {response.status_code}; expected {status}; '
            + json.dumps(self.exceptions, separators=(',', ':')))
        return response.json()

    async def connect(self, client, **overrides):
        flow = self.assert_status(await client.post('/login/providers/login_chatgpt/auth/start', json={}))
        payload = {'flow_id': flow['flow_id'], 'state': flow['state'], 'browser_instance': 'd' * 48,
            'expected_identity': hashlib.sha256((USER + '\0' + ACCOUNT).encode()).hexdigest(),
            'credentials': {'access_token': ACCESS, 'account_id': ACCOUNT, 'device_id': DEVICE}}
        payload.update(overrides)
        return await client.post('/login/providers/login_chatgpt/auth/endpoint-import', json=payload)

    def payload(self, session_id, page=10, **overrides):
        uid = f'I{page}_P0'
        value = {'schema': 'tp.ai.request/1', 'operationId': f'operation-{page}', 'batchId': 'user-click-10441',
            'translationMode': 'conversation', 'units': [{'id': uid, 'text': 'Hello world'}],
            'sourceLang': 'en', 'targetLang': 'th',
            'provider': {'id': 'login', 'model': session_id + '/fixture-model',
                'apiKey': 'a' * 64, 'thinking': 'default'},
            'memory': {'mode': 'off', 'styleExamples': False}, 'repair': {'owner': 'extension', 'enabled': False},
            'context': {'tp_tab_session': 'owned-tab-10441'},
            'conversation': {'documentId': 'owned-document-10441', 'webchatRunId': 'user-click-10441',
                'pageId': f'page-{page}', 'pageOrder': page, 'origins': [{'pageId': f'page-{page}',
                    'pageOrder': page, 'unitIds': [uid], 'originalIds': ['g0']}]}}
        value.update(overrides)
        return value

    async def repair_task(self, client, run_id='repair-10441', page=12):
        base = '/v2/engine/runsextension/repair-runs'
        for suffix, body in (('', {'runId': run_id, 'manifest': [f'page-{page}']}),
            (f'/{run_id}/pages', {'pageId': f'page-{page}', 'generationId': 'main',
                'groupKey': 'e' * 64, 'status': 'finished', 'failed': [{'id': 'g0', 'text': 'Hello world',
                    'sourceHash': repair_state.source_hash('Hello world'), 'reason': 'missing'}]}),
            (f'/{run_id}/seal', {}), (f'/{run_id}/claim', {'taskId': 'task', 'executor': 'extension',
                'route': 'server', 'ids': ['R0']})):
            self.assert_status(await client.post(base + suffix, json=body))
        return base + f'/{run_id}'

    def assert_private_material_absent(self, *values):
        evidence = json.dumps((self.observed, values), ensure_ascii=False, default=str)
        for path in Path(self.tmp.name).rglob('*'):
            if path.is_file():
                evidence += path.read_text('utf-8', errors='replace')
        for private in (ACCESS, ACCESS_B, PREPARATION, USER, USER_B, ACCOUNT, ACCOUNT_B, DEVICE,
                        'private-fixture-email@example.invalid', 'Private fixture name', CID):
            self.assertFalse(private in evidence, 'Private provider material escaped into public diagnostics/wire artifacts')

    def test_normal_login_main_repair_retained_parent_replay_and_private_wire(self):
        async def exercise():
            async with self.client() as client:
                connected = self.assert_status(await self.connect(client))
                self.assertEqual(connected['generation_validation'], 'not_tested')
                self.assertEqual([row['id'] for row in connected['models']], ['fixture-model'])
                sid = connected['session']['id']
                for page in (10, 11):
                    payload = self.payload(sid, page)
                    result = self.assert_status(await client.post('/v2/engine/runsextension/login/translate',
                        json=payload, headers={'Idempotency-Key': f'operation-{page}'}))
                    self.assertEqual(result['translations'][0]['text'], 'ทดสอบ')
                    self.assertEqual(result['missing'], [])
                    self.assertEqual(result['meta']['generationAttempts'], 1)
                prior = len(self.fixture.generations)
                replay = self.assert_status(await client.post('/v2/engine/runsextension/login/translate',
                    json=self.payload(sid, 11), headers={'Idempotency-Key': 'operation-11'}))
                self.assertEqual(replay['meta']['generationAttempts'], 0)
                self.assertEqual(len(self.fixture.generations), prior)
                base = await self.repair_task(client)
                payload = self.payload(sid, 12)
                payload['conversation']['origins'][0]['originalIds'] = ['R0']
                payload['conversation']['branch'] = 'repair'
                result = self.assert_status(await client.post(base + '/tasks/task/translate', json=payload))
                self.assertEqual(result['translations'][0]['id'], 'R0')
                self.assertEqual(result['translations'][0]['text'], 'ทดสอบ')
                replay = self.assert_status(await client.post(base + '/tasks/task/translate', json=payload))
                self.assertTrue(replay['replayed']); self.assertEqual(replay['meta']['providerAttempts'], 0)
                self.assertEqual(len(self.fixture.generations), 3)
                done = self.assert_status(await client.post(base + '/tasks/task/complete', json={'accepted': ['R0']}))
                self.assertEqual(done['repaired'], 1)
                bodies = [row['body'] for row in self.fixture.generations]
                self.assertNotIn('conversation_id', bodies[0])
                self.assertEqual([row['conversation_id'] for row in bodies[1:]], [CID, CID])
                self.assertEqual(bodies[1]['parent_message_id'], 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001')
                self.assertEqual(bodies[2]['parent_message_id'], 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002')
                self.assertEqual(bodies[1]['messages'][0]['content']['parts'], ['<<I11_P0:Hello world>>'])
                self.assertEqual(bodies[2]['messages'][0]['content']['parts'], ['<<I12_P0:Hello world>>'])
                self.assertEqual(self.fixture.prepare_count, 4, 'Import plus each actual generation must prepare freshly')
                self.assert_private_material_absent(connected, result, replay, done)
        asyncio.run(exercise())

    def test_cross_owner_and_workspace_cannot_use_session_or_bind_wrong_identity(self):
        async def exercise():
            async with self.client() as owner, self.client('b' * 64) as other:
                connected = self.assert_status(await self.connect(owner))
                sid = connected['session']['id']
                stolen = self.payload(sid); stolen['provider']['apiKey'] = 'b' * 64
                reply = await other.post('/v2/engine/runsextension/login/translate', json=stolen)
                self.assert_status(reply, 401)
                self.assertEqual(len(self.fixture.generations), 0)
                mismatch = await self.connect(other, expected_identity='f' * 64)
                self.assert_status(mismatch, 409)
                self.assertEqual(len(login_session_store.owned('tp-owner-b')), 0)
                # A different configured Center is a different ownership scope.
                with patch.object(paid_center, 'settings', replace(settings,
                        center_url='https://other-center.fixture.invalid')):
                    reply = await owner.get('/login/providers/login_chatgpt/models', params={'session_id': sid})
                    self.assert_status(reply, 401)
                self.fixture.user = 'changed_provider_user'
                reply = await owner.post('/v2/engine/runsextension/login/translate', json=self.payload(sid))
                self.assert_status(reply, 409)
                self.assertEqual(len(self.fixture.generations), 0)
                self.assert_private_material_absent(connected, mismatch.json(), reply.json())
        asyncio.run(exercise())

    def test_unknown_credentials_and_cancelled_import_never_contact_provider(self):
        async def exercise():
            async with self.client() as client:
                flow = self.assert_status(await client.post('/login/providers/login_chatgpt/auth/start', json={}))
                base = {'flow_id': flow['flow_id'], 'state': flow['state'], 'browser_instance': 'd' * 48,
                    'expected_identity': hashlib.sha256((USER + '\0' + ACCOUNT).encode()).hexdigest()}
                for credentials in ({'access_token': ACCESS, 'account_id': ACCOUNT, 'destination': 'https://other.invalid'},
                    {'access_token': ACCESS, 'account_id': ACCOUNT, 'headers': 'synthetic'},
                    {'access_token': ACCESS + '\nsecret', 'account_id': ACCOUNT}):
                    reply = await client.post('/login/providers/login_chatgpt/auth/endpoint-import',
                        json={**base, 'credentials': credentials})
                    self.assert_status(reply, 400)
                self.assertEqual([call for call in self.fixture.calls if call[1] == 'chatgpt.com'], [])
                self.assert_status(await client.post('/login/providers/login_chatgpt/auth/cancel', json={'flow_id': flow['flow_id']}))
                reply = await client.post('/login/providers/login_chatgpt/auth/endpoint-import',
                    json={**base, 'credentials': {'access_token': ACCESS, 'account_id': ACCOUNT}})
                self.assert_status(reply, 404)
                self.assertEqual(len(login_session_store.owned('tp-owner-a')), 0)
        asyncio.run(exercise())

    def test_answered_repair_receipt_cannot_cross_customer_or_reconnected_session(self):
        async def exercise():
            async with self.client() as owner, self.client('b' * 64) as other:
                connected = self.assert_status(await self.connect(owner))
                other_connected = self.assert_status(await self.connect(other,
                    credentials={'access_token': ACCESS_B, 'account_id': ACCOUNT_B},
                    expected_identity=hashlib.sha256((USER_B + '\0' + ACCOUNT_B).encode()).hexdigest()))
                base = await self.repair_task(owner)
                payload = self.payload(connected['session']['id'], 12)
                payload['conversation']['origins'][0]['originalIds'] = ['R0']
                payload['conversation']['branch'] = 'repair'
                answer = self.assert_status(await owner.post(base + '/tasks/task/translate', json=payload))
                changed = self.payload(other_connected['session']['id'], 12)
                changed['conversation'] = payload['conversation']
                changed['provider']['apiKey'] = 'b' * 64
                self.assert_status(await other.post(base + '/tasks/task/translate', json=changed), 403)
                reconnected = self.assert_status(await self.connect(owner))
                payload['provider']['model'] = reconnected['session']['id'] + '/fixture-model'
                self.assert_status(await owner.post(base + '/tasks/task/translate', json=payload), 403)
                self.assertEqual(len(self.fixture.generations), 1, 'Repair ownership changes must not expose/replay a prior provider receipt')
                self.assert_private_material_absent(connected, other_connected, answer)
        asyncio.run(exercise())

    def test_state_owner_and_expired_flow_rejected_before_provider_or_binding(self):
        async def exercise():
            async with self.client() as owner, self.client('b' * 64) as other:
                flow = self.assert_status(await owner.post('/login/providers/login_chatgpt/auth/start', json={}))
                payload = {'flow_id': flow['flow_id'], 'state': flow['state'], 'browser_instance': 'd' * 48,
                    'expected_identity': hashlib.sha256((USER + '\0' + ACCOUNT).encode()).hexdigest(),
                    'credentials': {'access_token': ACCESS, 'account_id': ACCOUNT}}
                route = '/login/providers/login_chatgpt/auth/endpoint-import'
                self.assert_status(await other.post(route, json=payload), 404)
                for bad_state in ('wrong-state-value', 'é' * 16):
                    self.assert_status(await owner.post(route, json={**payload, 'state': bad_state}), 400)
                self.assertEqual([call for call in self.fixture.calls if call[1] == 'chatgpt.com'], [])
                login_endpoint_session._flows[flow['flow_id']]['expires'] = time.monotonic() - 1
                self.assert_status(await owner.post(route, json=payload), 410)
                self.assertEqual([call for call in self.fixture.calls if call[1] == 'chatgpt.com'], [])
                self.assertEqual(len(login_session_store.owned('tp-owner-a')), 0)
                self.assertEqual(len(login_session_store.owned('tp-owner-b')), 0)
        asyncio.run(exercise())

    def test_proof_required_stops_import_and_turn_without_generation_or_fake_challenge(self):
        async def exercise():
            async with self.client() as client:
                self.fixture.proof = True
                rejected = await self.connect(client)
                self.assert_status(rejected, 409)
                self.assertEqual(len(login_session_store.owned('tp-owner-a')), 0)
                self.assertEqual(len(self.fixture.generations), 0)
                self.fixture.proof = False
                connected = self.assert_status(await self.connect(client))
                self.fixture.proof = True
                payload = self.payload(connected['session']['id'])
                rejected = await client.post('/v2/engine/runsextension/login/translate', json=payload)
                body = self.assert_status(rejected, 409)
                self.assertFalse(body['detail']['requestDispatched'])
                self.assertEqual(body['detail']['providerAttempts'], 0)
                before = self.fixture.prepare_count
                rejected = await client.post('/v2/engine/runsextension/login/translate', json=payload)
                self.assert_status(rejected, 409)
                self.assertEqual(self.fixture.prepare_count, before, 'The same failed operation must never resubmit native preparation')
                self.assertEqual(len(self.fixture.generations), 0)
                self.assert_private_material_absent(connected, body)
        asyncio.run(exercise())

    def test_terminal_error_or_incomplete_stream_never_becomes_success_or_replays(self):
        async def exercise():
            for incomplete in (False, True):
                async with self.client() as client:
                    connected = self.assert_status(await self.connect(client))
                    self.fixture.stream_error, self.fixture.incomplete = not incomplete, incomplete
                    payload = self.payload(connected['session']['id'])
                    before = len(self.fixture.generations)
                    result = await client.post('/v2/engine/runsextension/login/translate', json=payload)
                    body = self.assert_status(result, 502)
                    self.assertTrue(body['detail']['requestDispatched'])
                    self.assertNotIn('translations', body)
                    again = await client.post('/v2/engine/runsextension/login/translate', json=payload)
                    self.assert_status(again, 409)
                    self.assertEqual(len(self.fixture.generations), before + 1)
                    self.assert_private_material_absent(connected, body, again.json())
        asyncio.run(exercise())

    def test_repair_explicit_cancel_retains_failure_and_cannot_dispatch_again(self):
        async def exercise():
            async with self.client() as client:
                connected = self.assert_status(await self.connect(client))
                base = await self.repair_task(client, page=20)
                payload = self.payload(connected['session']['id'], 20)
                payload['conversation']['origins'][0]['originalIds'] = ['R0']
                payload['conversation']['branch'] = 'repair'
                self.fixture.block_stream = True
                pending = asyncio.create_task(client.post(base + '/tasks/task/translate', json=payload))
                self.assertTrue(await asyncio.to_thread(self.fixture.entered.wait, 5), 'Actual provider stream did not begin')
                self.assert_status(await client.post(base + '/cancel', json={}))
                await asyncio.sleep(.3)  # repair cancellation's documented bounded poll cache
                self.fixture.release.set()
                response = await pending
                body = self.assert_status(response, 409)
                self.assertTrue(body['detail']['requestDispatched'])
                snapshot = self.assert_status(await client.get(base))
                self.assertEqual(snapshot['phase'], 'cancelled')
                again = await client.post(base + '/tasks/task/translate', json=payload)
                self.assertEqual(self.assert_status(again, 409)['detail']['code'], 'repair_run_cancelled')
                self.assertEqual(len(self.fixture.generations), 1)
                self.assert_private_material_absent(connected, body, snapshot)
        asyncio.run(exercise())


if __name__ == '__main__':
    unittest.main(verbosity=2)
