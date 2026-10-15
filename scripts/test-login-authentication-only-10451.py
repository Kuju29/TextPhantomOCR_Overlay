"""Actual RAM Login import and fixed HTTPS, with synthetic provider replies.

Authentication-only is a server capability decision, never a browser assertion
or evidence that catalogue, request preparation, or generation worked live.
"""
import hashlib
import json
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai.login import login_native as native, login_profiles as profiles
from backend.ai.login import login_provider_registry as registry, login_routes as routes
from backend.ai.login import login_session_store as store
from backend.ai.login.endpoint import login_endpoint_http as endpoint, login_endpoint_session as flows
from backend.ai.login.login_provider_contract import LoginError
from login_relay_fixture import relay_via

CLIENT = httpx.Client
OWNER = 'fictional-tp-owner'
CREDS = {
    # .77: Sign in with ChatGPT; the token stays in the extension, the API gets mode/account/plan.
    'login_chatgpt': {'mode': 'official', 'account': 'a' * 64, 'plan': 'plus'},
    'login_claude': {'organization': 'owned-workspace'},  # .75: session stays in the browser tab
}
IDENTITY = 'owned-user\0owned-workspace'
IDENTITIES = {'login_chatgpt': 'chatgpt-official\0' + 'a' * 64, 'login_claude': IDENTITY}


@contextmanager
def transport(handler):
    with patch.object(endpoint.httpx, 'Client', side_effect=lambda **kw: CLIENT(transport=httpx.MockTransport(handler), **kw)), \
            patch.object(endpoint.diagnostic, 'emit'), patch.object(endpoint.diagnostic, 'stage'), relay_via(handler):
        yield


class AuthenticationOnlyImport(unittest.TestCase):
    # .69+: ChatGPT/Claude translation is enabled for testing. The sign-in-only
    # path still exists for any provider marked under improvement; keep testing
    # it by marking these two as such for this suite.
    def setUp(self):
        self._gate = patch.object(registry, 'TRANSLATION_UNDER_IMPROVEMENT',
                                  frozenset({'login_chatgpt', 'login_claude'}))
        self._gate.start()
        flows.clear()
        store.clear()
        self.calls = []

    def tearDown(self):
        flows.clear()
        store.clear()
        self._gate.stop()

    def response(self, request):
        self.calls.append((request.method, request.url.host, request.url.path))
        if request.url.host not in ('claude.ai', 'api.openai.com'):  # .75/.77: relayed by the browser
            self.assertEqual(request.headers['user-agent'], 'TextPhantom')
        self.assertNotIn('sec-fetch-site', request.headers)
        if request.url.host == 'api.openai.com' and request.url.path == '/v1/models':
            return httpx.Response(200, json={'models': [{'slug': 'gpt-fixture', 'visibility': 'list'}]})
        if request.url.host == 'claude.ai' and request.url.path == '/api/bootstrap':
            return httpx.Response(200, json={'account': {'uuid': 'owned-user', 'lastActiveOrgId': 'owned-workspace'}})
        if request.url.host == 'claude.ai' and request.url.path == '/api/organizations':
            return httpx.Response(200, json=[{'uuid': 'owned-workspace'}, {'uuid': 'another-workspace'}])
        # Current pre-fix code unnecessarily reaches a protected catalogue.
        return httpx.Response(403, text='<html>fixture</html>',
                              headers={'content-type': 'text/html', 'cf-mitigated': 'challenge'})

    def complete(self, provider, *, identity=None, creds=None, authorize=None, response=None):
        identity = IDENTITIES[provider] if identity is None else identity
        flow = flows.start(OWNER, provider)
        with transport(response or self.response):
            result = flows.complete(OWNER, provider, flow['flow_id'], flow['state'], 'fictional-browser',
                                    hashlib.sha256(identity.encode()).hexdigest(),
                                    dict(CREDS[provider]) if creds is None else creds, authorize or (lambda: OWNER))
        return result, flow

    def assert_authentication_only(self, provider, result):
        self.assertEqual(result['status'], 'connected')
        self.assertEqual(result['models'], [])
        self.assertEqual(result['endpoint_validation'], 'identity_verified')
        self.assertEqual(result['generation_validation'], 'not_tested')
        self.assertIs(result['authentication_only'], True)
        self.assertIs(result['session']['authentication_only'], True)
        self.assertEqual(result['session']['authentication_validation'], 'identity_verified')
        self.assertEqual(result['session']['generation_validation'], 'not_tested')
        self.assertNotIn('preparation_validation', result)
        row = store.get(result['session']['id'], OWNER)
        self.assertEqual(profiles.model_list(row), [])
        tokens = store.credential_for_session(row)['tokens']
        self.assertIs(tokens['authentication_only'], True)
        self.assertEqual(tokens['models'], [])
        # Public evidence is a bounded status, never the private verified owner.
        wire = json.dumps(result)
        for value in ('owned-user', 'owned-workspace', 'fictional-access-token', 'fictional-session-key'):
            self.assertNotIn(value, wire)
        with self.assertRaises(LoginError) as blocked:
            registry.require_translation_supported(provider)
        self.assertEqual(blocked.exception.code, 'login_translation_unsupported')

    def test_chatgpt_verified_identity_signs_in_without_catalogue_or_preparation(self):
        result, flow = self.complete('login_chatgpt')
        self.assert_authentication_only('login_chatgpt', result)
        self.assertEqual(self.calls, [('GET', 'api.openai.com', '/v1/models')])
        self.assertEqual(flows.status(OWNER, 'login_chatgpt', flow['flow_id']), result)

    def test_claude_signin_requires_exact_account_workspace_and_membership_only(self):
        result, _ = self.complete('login_claude')
        self.assert_authentication_only('login_claude', result)
        self.assertEqual(self.calls, [('GET', 'claude.ai', '/api/bootstrap'), ('GET', 'claude.ai', '/api/organizations')])

    def test_authentication_401_and_identity_challenge_never_bind(self):
        for provider in CREDS:
            for status in (401, 403):
                with self.subTest(provider=provider, status=status):
                    def denied(request):
                        self.calls.append(request.url.path)
                        headers = {'content-type': 'text/html', 'cf-mitigated': 'challenge'} if status == 403 else {}
                        return httpx.Response(status, text='fixture', headers=headers)
                    with self.assertRaises(LoginError):
                        self.complete(provider, response=denied)
                    self.assertEqual(store.owned(OWNER, provider), [])

    def test_malformed_verified_identity_and_memberships_never_fall_back(self):
        for provider, step, value in [('login_chatgpt', '/v1/models', {'models': None}),
                                      ('login_claude', '/api/bootstrap', {'account': []}),
                                      ('login_claude', '/api/organizations', {'uuid': 'owned-workspace'})]:
            with self.subTest(provider=provider, step=step):
                def malformed(request):
                    if request.url.path == step:
                        return httpx.Response(200, json=value)
                    return self.response(request)
                with self.assertRaises(LoginError):
                    self.complete(provider, response=malformed)
                self.assertEqual(store.owned(OWNER, provider), [])

    def test_claude_changed_workspace_and_missing_membership_never_bind(self):
        for current, memberships in [('another-workspace', ['owned-workspace']),
                                     ('owned-workspace', ['another-workspace'])]:
            with self.subTest(current=current):
                def wrong(request):
                    self.calls.append(request.url.path)
                    if request.url.path == '/api/bootstrap':
                        return httpx.Response(200, json={'account': {'uuid': 'owned-user', 'lastActiveOrgId': current}})
                    return httpx.Response(200, json=[{'uuid': item} for item in memberships])
                with self.assertRaises(LoginError) as error:
                    self.complete('login_claude', response=wrong)
                self.assertIn(error.exception.code, ('login_account_changed', 'login_organization_required'))
                self.assertEqual(store.owned(OWNER, 'login_claude'), [])

    def test_browser_identity_hash_mismatch_never_creates_signed_in_status(self):
        for provider in CREDS:
            with self.subTest(provider=provider), self.assertRaises(LoginError) as error:
                self.complete(provider, identity='foreign-user\0owned-workspace')
            self.assertEqual(error.exception.code, 'login_account_changed')
            self.assertEqual(store.owned(OWNER, provider), [])

    def test_client_cannot_select_authentication_only_or_import_metadata(self):
        for provider in CREDS:
            for field in ('authentication_only', 'models', 'generation_validation'):
                with self.subTest(provider=provider, field=field), self.assertRaises(LoginError) as error:
                    self.complete(provider, creds={**CREDS[provider], field: 'true'})
                self.assertEqual(error.exception.code, 'login_credentials_invalid')
        self.assertEqual(self.calls, [])

    def test_supported_provider_cannot_accept_authentication_only_adapter_result(self):
        for provider in ('login_chatgpt', 'login_claude'):
            for models in ([], [{'id': 'invented', 'name': 'invented', 'model_capabilities': {}}]):
                verified = {'identity': IDENTITIES[provider], 'credentials': dict(CREDS[provider]),
                            'models': models, 'authentication_only': True}
                fake = SimpleNamespace(endpoint_validate=lambda *args: verified,
                                       endpoint_authenticate=lambda *args: verified)
                with self.subTest(provider=provider, count=len(models)), patch.object(registry, 'translation_supported', return_value=True), \
                        patch.object(native, 'module', return_value=fake), self.assertRaises(LoginError) as error:
                    self.complete(provider)
                self.assertEqual(error.exception.code, 'login_endpoint_response_invalid')
                self.assertEqual(store.owned(OWNER, provider), [])

    def test_support_change_during_import_requires_full_reconnect_before_binding(self):
        with patch.object(registry, 'translation_supported', side_effect=[False, True]), self.assertRaises(LoginError) as error:
            self.complete('login_chatgpt')
        self.assertEqual(error.exception.code, 'login_endpoint_response_invalid')
        self.assertEqual(store.owned(OWNER, 'login_chatgpt'), [])
        self.assertEqual(self.calls, [('GET', 'api.openai.com', '/v1/models')])

    def test_authentication_only_contract_rejects_malformed_flags_and_models(self):
        for flag, models in [(None, []), (False, []), ('true', []), (True, None),
                             (True, [{'id': 'invented', 'name': 'invented', 'model_capabilities': {}}])]:
            with self.subTest(flag=flag, models=type(models).__name__):
                verified = {'identity': IDENTITIES['login_chatgpt'], 'credentials': dict(CREDS['login_chatgpt']),
                            'models': models, 'authentication_only': flag}
                fake = SimpleNamespace(endpoint_authenticate=lambda *args: verified,
                                       endpoint_validate=lambda *args: verified)
                with patch.object(native, 'module', return_value=fake), self.assertRaises(LoginError) as error:
                    self.complete('login_chatgpt')
                self.assertEqual(error.exception.code, 'login_endpoint_response_invalid')
                self.assertEqual(store.owned(OWNER, 'login_chatgpt'), [])

    def test_existing_supported_provider_empty_catalogue_still_rejected(self):
        flow = flows.start(OWNER, 'login_deepseek')
        verified = {'identity': IDENTITY, 'credentials': {'token': 'fictional-provider-token'}, 'models': [], 'authentication_only': True}
        with patch.object(native, 'module', return_value=SimpleNamespace(endpoint_validate=lambda *args: verified)), \
                self.assertRaises(LoginError) as error:
            flows.complete(OWNER, 'login_deepseek', flow['flow_id'], flow['state'], 'fictional-browser',
                           hashlib.sha256(IDENTITY.encode()).hexdigest(), {'token': 'fictional-provider-token'}, lambda: OWNER)
        self.assertEqual(error.exception.code, 'login_endpoint_response_invalid')

    def test_reauthorization_owner_change_and_cancellation_leave_no_auth_session(self):
        for provider in CREDS:
            with self.subTest(provider=provider, mode='owner'), self.assertRaises(LoginError) as error:
                self.complete(provider, authorize=lambda: 'foreign-tp-owner')
            self.assertEqual(error.exception.code, 'login_owner_changed')
            flow = flows.start(OWNER, provider)
            def cancelled(request):
                result = self.response(request)
                flows.cancel(OWNER, provider, flow['flow_id'])
                return result
            with transport(cancelled), self.assertRaises(LoginError):
                flows.complete(OWNER, provider, flow['flow_id'], flow['state'], 'fictional-browser',
                               hashlib.sha256(IDENTITIES[provider].encode()).hexdigest(), dict(CREDS[provider]), lambda: OWNER)
            self.assertEqual(store.owned(OWNER, provider), [])

    def test_owned_routes_preserve_auth_only_status_without_new_http(self):
        result, _ = self.complete('login_chatgpt')
        calls = list(self.calls)
        async def inline(action, *args, **kwargs):
            return action()
        def finish(coroutine):
            try:
                coroutine.send(None)
            except StopIteration as done:
                return done.value
            finally:
                coroutine.close()
            raise AssertionError('Unexpected asynchronous suspension')
        request = Request({'type': 'http', 'headers': [(b'authorization', b'Bearer fictional-tp-token')]})
        with patch.object(routes, 'call', inline), patch.object(routes.login_entitlement, 'authorize', return_value=OWNER):
            provider_list = finish(routes.providers(request))
            row = next(row for row in provider_list['providers'] if row['id'] == 'login_chatgpt')
            self.assertIs(row['sign_in_available'], True)
            self.assertIs(row['translation_supported'], False)
            self.assertIs(row['session']['authentication_only'], True)
            models = finish(routes.models('login_chatgpt', request, result['session']['id']))
            self.assertEqual(models['models'], [])
            self.assertIs(models['session']['authentication_only'], True)
        with patch.object(routes, 'call', inline), patch.object(routes.login_entitlement, 'authorize', return_value='foreign-tp-owner'), \
                self.assertRaises(LoginError) as error:
            finish(routes.models('login_chatgpt', request, result['session']['id']))
        self.assertEqual(error.exception.code, 'login_session_expired')
        self.assertEqual(self.calls, calls)
        flows.disconnect(OWNER, 'login_chatgpt', result['session']['id'])
        with self.assertRaises(LoginError):
            store.get(result['session']['id'], OWNER)


if __name__ == '__main__':
    unittest.main()
