""".91 regression: a Login website session with a verified thinking switch
(DeepSeek DeepThink, ENDPOINT_THINKING=True) delivers the user's saved AI think
choice end to end through the real translation route; websites without a
switch (Gemini web) receive nothing and stay website-managed.

Before the fix invocation forced "default" for every web-endpoint session, so
DeepSeek always received thinking="default" (DeepThink off) whatever was saved.
Offline: fictional HTTP route and endpoint modules; no account, network or secrets.
"""
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
from fastapi import FastAPI  # noqa: E402
from backend.api.routes.ai_v1 import router  # noqa: E402
from backend.ai import provider_resolution  # noqa: E402
from backend.ai.login import login_translation as adapter  # noqa: E402
from backend.ai.login import login_provider_deepseek as deepseek  # noqa: E402
from backend.ai.login.endpoint import login_endpoint_http as endpoint_http  # noqa: E402
from backend.ai.login.endpoint import login_endpoint_runs as runs  # noqa: E402
from backend.ai.provider_registry import provider_registry  # noqa: E402
from backend.ai.translation import invocation  # noqa: E402
from backend.jobs.admission import AdmissionGate  # noqa: E402

SESSION_ID = 'http-session'


def deepseek_row():
    row = deepseek.deepseek_model()
    row['model_capabilities']['limits'] = {'contextTokens': 32768, 'maxOutputTokens': 8192}
    return row


def website_row():
    row = endpoint_http.model('web-default', 'Gemini consumer default')
    row['model_capabilities']['limits'] = {'contextTokens': 32768, 'maxOutputTokens': 8192}
    return row


class WebsiteThinking(unittest.IsolatedAsyncioTestCase):
    async def translate(self, provider, row, thinking, *, switch, client_caps=None, fresh=True):
        if provider_registry.get('login') is None:
            provider_registry.register(adapter.SPEC)
        seen, notes = [], []

        def generate(credentials, prompt, remote, model, check, dispatch, **extra):
            seen.append(extra)
            dispatch()
            remote['thread'] = 'thread'
            return {'text': '<<I1_P0:สวัสดี>>', 'completed': True, 'statuses': [200], 'terminal': 'fixture'}
        site = SimpleNamespace(ENDPOINT_THINKING=switch, endpoint_generate=generate,
                               thinking_enabled=deepseek.thinking_enabled)
        session = {'id': SESSION_ID, 'provider': provider, 'credential': 'fixture'}
        app = FastAPI()
        app.include_router(router)
        app.state.ai_admission_gate = AdmissionGate(4, max_waiters=16, max_wait_sec=3)
        app.state.ai_executor = None
        runs.clear()
        cold = [] if fresh else [
            patch.object(provider_resolution, 'discovered_model_capabilities', return_value=(False, {})),
            patch.object(provider_resolution, 'refresh_cloud_model_capabilities', return_value=(False, {}))]
        patches = [
            patch.object(provider_resolution, '_MODEL_CAPABILITIES', {}),
            patch.object(adapter, 'authorize_model', return_value=('owner', session, 'web-default')),
            patch.object(adapter, 'selected_model', return_value=row),
            patch.object(adapter.login_profiles, 'model_list', return_value=[row]),
            patch.object(adapter.native, 'module', return_value=site),
            patch.object(runs.store, 'active_session_ids', return_value={SESSION_ID}),
            patch.object(runs.store, 'credential_for_session',
                         return_value={'tokens': {'transport': 'web_endpoint', 'credentials': {}}}),
            patch.object(invocation.trace_preview, 'note', side_effect=lambda label, data=None, **_: notes.append((label, data))),
            patch.dict(os.environ, {'TP_LOGIN_ENDPOINT_MIN_INTERVAL_MS': '0', 'TP_AI_WIRE_TRACE': '0'}),
            *cold]
        for item in patches:
            item.start()
        try:
            body = {'schema': 'tp.ai.request/1', 'operationId': 'op-' + thinking,
                    'translationMode': 'independent', 'conversation': {'webchatRunId': 'run-' + thinking},
                    'units': [{'id': 'P0', 'text': 'Hello'}], 'targetLang': 'th',
                    'provider': {'id': 'login', 'model': SESSION_ID + '/web-default', 'apiKey': 'fixture',
                                 'thinking': thinking, **({'modelCapabilities': client_caps} if client_caps else {})},
                    'memory': {'mode': 'off'}, 'repair': {'owner': 'extension', 'enabled': False}}
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                response = await client.post('/v2/engine/runsextension/login/translate', json=body)
        finally:
            for item in reversed(patches):
                item.stop()
            runs.clear()
        policy = next((data for label, data in notes if label == 'AI diagnostic reasoning policy resolved'), None)
        return response, seen, policy

    async def test_deepseek_switch_receives_saved_choice(self):
        for saved, sent, applied, effective in (('on', 'on', 'on', 'reasoning_active'),
                                                ('off', 'off', 'off', 'reasoning_off'),
                                                ('minimum', 'off', 'off', 'reasoning_off'),
                                                ('default', 'default', 'off', 'provider_default')):
            with self.subTest(saved=saved):
                response, seen, policy = await self.translate('login_deepseek', deepseek_row(), saved, switch=True)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(seen, [{'thinking': sent}])
                self.assertEqual(response.json()['meta']['thinkingApplied'], applied)
                self.assertEqual(policy['effectivePolicy'], effective)
                self.assertEqual(policy['selectedMode'], sent)

    async def test_choice_the_switch_cannot_express_is_reported_not_sent(self):
        response, seen, _ = await self.translate('login_deepseek', deepseek_row(), 'high', switch=True)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()['detail']['code'], 'ai_thinking_mode_unavailable')
        self.assertEqual(seen, [], 'nothing dispatched')

    async def test_cold_catalogue_never_becomes_default(self):
        # The browser snapshot claims the switch, but no fresh API record: loading.
        caps = deepseek_row()['model_capabilities']
        response, seen, _ = await self.translate('login_deepseek', deepseek_row(), 'on', switch=True,
                                                 client_caps=caps, fresh=False)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(seen, [], 'a slow/failed catalogue never dispatches with the website default')

    async def test_website_without_switch_receives_nothing(self):
        for saved in ('on', 'off', 'high'):
            with self.subTest(saved=saved):
                response, seen, policy = await self.translate('login_gemini', website_row(), saved, switch=False)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(seen, [{}])
                self.assertEqual(response.json()['meta']['thinkingApplied'], 'website_managed')
                self.assertEqual(policy['effectivePolicy'], 'website_managed')
                self.assertEqual(policy['overrideReason'], 'consumer_provider_controls_thinking')


if __name__ == '__main__':
    unittest.main()
