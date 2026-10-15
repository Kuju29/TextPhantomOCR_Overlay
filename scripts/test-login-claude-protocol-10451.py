"""Actual Claude endpoint boundary with fictional upstream, never a live account.

The response UUID retained by the public ClaudeClient/ChatSession implementation
is authoritative; a generated request UUID is not a provider acknowledgement.
Source: cyber-wojtek/Claude-API claude_webapi/client.py and session.py (mutable
main reviewed 2026-10-09; fixtures below are synthetic, not captured replies).
"""
import copy
import hashlib
import json
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai.login import login_provider_claude as provider
from backend.ai.login import login_provider_registry as registry
from backend.ai.login import login_session_store as store
from backend.ai.login.endpoint import login_endpoint_http as endpoint
from backend.ai.login.endpoint import login_endpoint_session as flows
from backend.ai.login.login_provider_contract import LoginError
from login_relay_fixture import relay_via

CLIENT = httpx.Client
# .75: the claude.ai session stays in the browser tab; only the organization reaches the API.
CREDS = {'organization': 'owned-org'}
MODEL, ANSWER = 'fixture-model', '<<I1_P0:สวัสดี>>'


def wire(events):
    return ''.join('event: ' + item['type'] + '\ndata: ' + json.dumps(item) + '\n\n'
                   for item in events).encode('utf-8')


def reply(mid='actual-answer-one', *, cid=None, reason='end_turn'):
    message = {'uuid': mid, 'role': 'assistant'}
    if cid is not None:
        message['conversation_uuid'] = cid
    return [
        {'type': 'message_start', 'message': message},
        {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
        {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': ANSWER}},
        {'type': 'content_block_stop', 'index': 0},
        {'type': 'message_delta', 'delta': {'stop_reason': reason}},
        {'type': 'message_stop'},
    ]


@contextmanager
def transport(handler):
    with patch.object(endpoint.httpx, 'Client', side_effect=lambda **kw: CLIENT(transport=httpx.MockTransport(handler), **kw)), \
            patch.object(endpoint.diagnostic, 'emit'), patch.object(endpoint.diagnostic, 'stage'), relay_via(handler):
        yield


class ClaudeEndpointContract(unittest.TestCase):
    def generate(self, events, remote=None, *, check=lambda: None):
        remote = {} if remote is None else remote
        calls = []
        def handler(request):
            calls.append(request)
            return httpx.Response(200, content=wire(events), headers={'content-type': 'text/event-stream'})
        with transport(handler):
            result = provider.endpoint_generate(CREDS, 'fictional prompt', remote, MODEL, check, lambda: calls.append('dispatch'))
        return result, remote, calls

    def test_actual_response_parent_is_retained_into_next_http_request(self):
        calls, remote = [], {}
        def handler(request):
            self.assertEqual(request.url.host, 'claude.ai')
            # .75 relay: the browser tab adds its own cookie; the API adds none.
            self.assertNotIn('cookie', request.headers)
            self.assertEqual(request.headers['accept'], 'text/event-stream')
            body = json.loads(request.content)
            calls.append(body)
            if len(calls) == 1:
                self.assertIn('create_conversation_params', body)
                self.assertNotIn('parent_message_uuid', body)
                self.assertEqual(body['tools'], [])
                self.assertEqual(body['attachments'], [])
            else:
                self.assertNotIn('create_conversation_params', body)
                self.assertEqual(body['parent_message_uuid'], 'actual-answer-one')
            cid = request.url.path.split('/')[-2]
            return httpx.Response(200, content=wire(reply('actual-answer-' + ('one' if len(calls) == 1 else 'two'), cid=cid)),
                                  headers={'content-type': 'text/event-stream'})
        with transport(handler):
            one = provider.endpoint_generate(CREDS, 'first', remote, MODEL, lambda: None, lambda: None)
            self.assertEqual(one['text'], ANSWER)
            self.assertEqual(remote['parent'], 'actual-answer-one')
            cid = remote['conversation']
            two = provider.endpoint_generate(CREDS, 'second', remote, MODEL, lambda: None, lambda: None)
        self.assertTrue(two['completed'])
        self.assertEqual(remote, {'conversation': cid, 'parent': 'actual-answer-two'})
        self.assertEqual(len(calls), 2)

    def test_missing_provider_message_id_cannot_create_continuation(self):
        events = reply()
        del events[0]['message']['uuid']
        remote = {}
        with self.assertRaises(LoginError) as caught:
            self.generate(events, remote)
        self.assertEqual(caught.exception.code, 'login_endpoint_response_invalid')
        self.assertEqual(remote, {})

    def test_conflicting_message_ids_or_conversation_fail_without_state_commit(self):
        for terminal in ({'uuid': 'foreign-answer'}, {'uuid': 'actual-answer-one', 'conversation_uuid': 'foreign-chat'}):
            with self.subTest(fields=tuple(terminal)):
                events = reply(cid='owned-chat')
                events[-1]['message'] = terminal
                remote = {'conversation': 'owned-chat', 'parent': 'prior-answer'}
                with self.assertRaises(LoginError):
                    self.generate(events, remote)
                self.assertEqual(remote, {'conversation': 'owned-chat', 'parent': 'prior-answer'})

    def test_conflicting_stop_reason_is_not_last_value_wins(self):
        events = reply(reason='max_tokens')
        events[-1]['stop_reason'] = 'end_turn'
        with self.assertRaises(LoginError):
            self.generate(events)

    def test_consistent_terminal_message_metadata_keeps_verified_parent(self):
        events = reply()
        events[-1]['message'] = {'uuid': 'actual-answer-one', 'role': 'assistant', 'stop_reason': 'end_turn'}
        result, remote, calls = self.generate(events)
        self.assertTrue(result['completed'])
        self.assertEqual(remote['parent'], 'actual-answer-one')
        self.assertEqual(len([item for item in calls if item == 'dispatch']), 1)

    def test_incomplete_retained_state_is_rejected_before_any_network(self):
        for remote in ({'parent': 'prior-answer'}, {'conversation': 'owned-chat'},
                       {'conversation': '', 'parent': 'prior-answer'}, ['invalid-state']):
            with self.subTest(shape=type(remote).__name__):
                calls = []
                def handler(request):
                    calls.append(request.url.path)
                    return httpx.Response(200, content=wire(reply()), headers={'content-type': 'text/event-stream'})
                with transport(handler), self.assertRaises(LoginError) as caught:
                    provider.endpoint_generate(CREDS, 'fictional prompt', copy.deepcopy(remote), MODEL,
                                               lambda: None, lambda: calls.append('dispatch'))
                self.assertEqual(caught.exception.code, 'login_endpoint_response_invalid')
                self.assertEqual(calls, [])

    def test_conversation_ready_before_message_is_accepted_10474(self):
        # Real claude.ai stream 2026-10-12: conversation_ready, message_start, ...,
        # message_delta, message_limit, message_stop.
        events = [{'type': 'conversation_ready'}] + reply()
        events.insert(-1, {'type': 'message_limit', 'message_limit': {'type': 'within_limit'}})
        result, remote, _ = self.generate(events)
        self.assertEqual(result['text'], ANSWER)
        # It never counts as content: after the message it is still rejected.
        with self.assertRaises(LoginError):
            self.generate(reply() + [{'type': 'conversation_ready'}])

    def test_incomplete_error_and_post_terminal_content_never_succeed(self):
        base = reply()
        cases = [base[:-1], reply(reason='max_tokens'), base + [copy.deepcopy(base[2])],
                 base[:-1] + [{'type': 'error', 'error': {'message': 'fictional upstream detail'}}]]
        for events in cases:
            with self.subTest(types=tuple(item['type'] for item in events)):
                remote = {}
                with self.assertRaises(LoginError) as caught:
                    self.generate(events, remote)
                self.assertEqual(remote, {})
                self.assertNotIn('fictional upstream detail', str(caught.exception))

    def test_malformed_identity_or_catalogue_is_typed_and_never_bound(self):
        malformed = [('/api/bootstrap', []), ('/api/bootstrap', {'account': []}),
                     ('catalogue', {'claude_ai_available_models': []}),
                     ('catalogue', {'claude_ai_available_models': {'models': [None]}})]
        for step, value in malformed:
            with self.subTest(step=step, shape=type(value).__name__):
                def handler(request):
                    if request.url.path == '/api/bootstrap':
                        return httpx.Response(200, json=value if step == '/api/bootstrap' else {'account': {'uuid': 'owned-account', 'lastActiveOrgId': 'owned-org'}})
                    if request.url.path == '/api/organizations':
                        return httpx.Response(200, json=[{'uuid': 'owned-org'}])
                    return httpx.Response(200, json=value)
                with transport(handler), self.assertRaises(LoginError) as caught:
                    provider.endpoint_validate(dict(CREDS), lambda: None)
                self.assertEqual(caught.exception.code, 'login_endpoint_response_invalid')

    def test_browser_challenge_stops_at_identity_with_no_fallback(self):
        calls = []
        def handler(request):
            calls.append(request.url.path)
            return httpx.Response(403, text='<html>fixture</html>', headers={'content-type': 'text/html', 'cf-mitigated': 'challenge'})
        with transport(handler), self.assertRaises(LoginError) as caught:
            provider.endpoint_validate(dict(CREDS), lambda: None)
        self.assertEqual(caught.exception.code, 'login_endpoint_challenge_required')
        self.assertEqual(caught.exception.endpoint_step, 'claude_identity')
        self.assertEqual(calls, ['/api/bootstrap'])

    def test_success_identity_is_still_bound_to_exact_organization(self):
        calls = []
        def handler(request):
            calls.append(request.url.path)
            if request.url.path == '/api/bootstrap':
                return httpx.Response(200, json={'account': {'uuid': 'owned-account', 'lastActiveOrgId': 'owned-org'}})
            if request.url.path == '/api/organizations':
                return httpx.Response(200, json=[{'uuid': 'owned-org'}, {'uuid': 'other-org'}])
            self.assertIn('/owned-org/', request.url.path)
            return httpx.Response(200, json={'claude_ai_available_models': {'models': [{'model_id': MODEL}]}})
        with transport(handler):
            result = provider.endpoint_validate(dict(CREDS), lambda: None)
        self.assertEqual(result['identity'], 'owned-account\0owned-org')
        self.assertEqual(result['credentials']['organization'], 'owned-org')
        self.assertEqual(result['models'][0]['id'], MODEL)
        self.assertEqual(len(calls), 3)


class ClaudeWorkspaceImport(unittest.TestCase):
    def setUp(self):
        flows.clear()
        store.clear()
        self.calls = []

    def tearDown(self):
        flows.clear()
        store.clear()

    def complete(self, *, credentials=None, selected='owned-org', current='owned-org',
                 memberships=('owned-org', 'other-org'), owner='fictional-owner', identity='owned-account', legacy_hash=False):
        flow = flows.start(owner, 'login_claude')
        expected = identity if legacy_hash else identity + '\0' + selected
        def handler(request):
            self.calls.append(request.url.path)
            if request.url.path == '/api/bootstrap':
                account = {'uuid': identity}
                if current is not None:
                    account['lastActiveOrgId'] = current
                return httpx.Response(200, json={'account': account})
            if request.url.path == '/api/organizations':
                return httpx.Response(200, json=[{'uuid': org} for org in memberships])
            # Old account-only imports could ask org B's valid catalogue; let
            # that real bug reach bind_native rather than hiding it in a mock.
            catalogue_org = current if legacy_hash else selected
            self.assertEqual(request.url.path, '/edge-api/bootstrap/' + catalogue_org + '/app_start')
            return httpx.Response(200, json={'claude_ai_available_models': {'models': [{'model_id': MODEL}]}})
        # This suite intentionally verifies the complete internal transport;
        # the separate auth-only suite exercises the public unsupported gate.
        with transport(handler), patch.object(registry, 'translation_supported', return_value=True):
            result = flows.complete(owner, 'login_claude', flow['flow_id'], flow['state'], 'fictional-browser',
                                    hashlib.sha256(expected.encode()).hexdigest(),
                                    dict(CREDS) if credentials is None else dict(credentials), lambda: owner)
        return result

    def test_matching_account_and_workspace_binds_real_complete(self):
        result = self.complete()
        self.assertEqual(result['status'], 'connected')
        row = store.get(result['session']['id'], 'fictional-owner')
        credentials = store.credential_for_session(row)['tokens']['credentials']
        self.assertEqual(credentials['organization'], 'owned-org')
        self.assertEqual(len(self.calls), 3)
        self.assertNotIn('session_key', json.dumps(result))
        self.assertNotIn('owned-org', json.dumps(result))

    def test_legacy_account_only_import_requires_reconnect_before_network(self):
        # This was the old browser payload: account A from organization A,
        # followed by a fresh API bootstrap for the same account in org B.
        with self.assertRaises(LoginError) as caught:
            self.complete(credentials={'session_key': 'old-extension-key', 'organization': 'owned-org'}, current='other-org', legacy_hash=True)
        self.assertEqual(caught.exception.code, 'login_reconnect_required')
        self.assertEqual(self.calls, [])
        self.assertEqual(store.owned('fictional-owner', 'login_claude'), [])

    def test_changed_current_workspace_does_not_rebind_or_fetch_foreign_catalogue(self):
        with self.assertRaises(LoginError) as caught:
            self.complete(current='other-org')
        self.assertEqual(caught.exception.code, 'login_account_changed')
        self.assertNotIn('/edge-api/bootstrap/other-org/app_start', self.calls)
        self.assertEqual(store.owned('fictional-owner', 'login_claude'), [])

    def test_missing_current_workspace_uses_only_verified_captured_member(self):
        result = self.complete(current=None)
        self.assertEqual(result['status'], 'connected')
        self.assertEqual(self.calls[-1], '/edge-api/bootstrap/owned-org/app_start')

    def test_captured_workspace_missing_from_memberships_is_not_replaced(self):
        with self.assertRaises(LoginError) as caught:
            self.complete(current=None, memberships=('other-org',))
        self.assertEqual(caught.exception.code, 'login_organization_required')
        self.assertEqual(self.calls, ['/api/bootstrap', '/api/organizations'])

    def test_another_tp_owner_cannot_import_the_same_account_workspace(self):
        self.complete()
        with self.assertRaises(LoginError) as caught:
            self.complete(owner='foreign-owner')
        self.assertEqual(caught.exception.code, 'login_account_in_use')
        self.assertEqual(len(store.owned('fictional-owner', 'login_claude')), 1)
        self.assertEqual(store.owned('foreign-owner', 'login_claude'), [])


if __name__ == '__main__':
    unittest.main()
