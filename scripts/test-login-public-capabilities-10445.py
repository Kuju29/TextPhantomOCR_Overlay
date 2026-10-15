"""Real public Login capability/start/generation boundary, fictional RAM sessions only."""
import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai.login import login_routes as routes, login_translation as translation
from backend.ai.login import login_session_store as store
from backend.ai.login.endpoint import login_endpoint_session as flows, login_endpoint_runs as runs
from backend.ai.login.login_provider_contract import LoginError


class PublicCapabilities(unittest.TestCase):
    def setUp(self):
        store.clear(); flows.clear(); runs.clear()
        self.env=patch.dict(os.environ,{'TP_CENTER_URL':'http://127.0.0.1:9999','TP_AI_WIRE_TRACE':'0',
            'TP_LOGIN_ENABLED_PROVIDERS':'login_chatgpt,login_claude,login_gemini,login_deepseek',
            'TP_LOGIN_ENDPOINT_MIN_INTERVAL_MS':'0'})
        self.env.start()
        self.auth=patch.object(routes.login_entitlement,'authorize',return_value='fiction-only-owner')
        self.auth.start()
        self.request=SimpleNamespace(headers={'authorization':'Bearer '+'x'*48},state=SimpleNamespace())
        self.selected={'id':'web-default','name':'Fiction default','model_capabilities':{},'_metadata':{}}

    def tearDown(self):
        self.auth.stop(); self.env.stop(); store.clear(); flows.clear(); runs.clear()

    def bind(self, provider):
        return store.bind_native('fiction-only-owner',provider,'fiction-identity-'+provider,
            {'transport':'web_endpoint','credentials':{},'models':[self.selected],'no_refresh':True})

    def invoke(self, coroutine):
        # Run the real route's synchronous owner/policy action; only its
        # scheduling wrapper is replaced, avoiding a Windows loopback socket.
        from fastapi.responses import JSONResponse
        async def call(action,*args,**kwargs): return JSONResponse(action())
        with patch.object(routes,'call',call):
            try: coroutine.send(None)
            except StopIteration as result: return result.value
            else: raise AssertionError('Unexpected asynchronous policy operation')

    def test_public_descriptor_separates_signin_from_translation(self):
        response=self.invoke(routes.providers(self.request))
        rows={p['id']:p for p in json.loads(response.body)['providers']}
        # .69+: translation is enabled for testing; the label stays "under improvement".
        # .75: Claude goes through the customer's claude.ai tab and is supported.
        # .77: ChatGPT uses Sign in with ChatGPT (paid) or the chatgpt.com tab (free).
        for provider in ('login_gemini','login_deepseek','login_claude','login_chatgpt'):
            self.assertTrue(rows[provider]['sign_in_available'])
            self.assertTrue(rows[provider]['translation_supported'])
            self.assertEqual(rows[provider]['support_status'],'supported')

    def test_unsupported_translation_still_opens_normal_signin_flow(self):
        for provider in ('login_chatgpt','login_claude'):
            response=self.invoke(routes.start(provider,self.request))
            result=json.loads(response.body)
            self.assertEqual(response.status_code,200)
            self.assertEqual(result['status'],'pending')
            self.assertEqual(result['transport'],'web_endpoint')

    def test_generation_rejected_before_provider_dispatch_or_charge(self):
        # .69+: the gate still exists for any provider marked under improvement.
        from backend.ai.login import login_provider_registry as registry
        gate=patch.object(registry,'TRANSLATION_UNDER_IMPROVEMENT',frozenset({'login_chatgpt','login_claude'}))
        gate.start(); self.addCleanup(gate.stop)
        for provider in ('login_chatgpt','login_claude'):
            with self.subTest(provider=provider):
                session=self.bind(provider); calls=[]
                def generate(credentials,prompt,remote,selected,check,dispatch):
                    dispatch(); calls.append(prompt); remote['thread']='fiction'
                    return {'text':'<<P0:สวัสดี>>','completed':True,'terminal':'fixture','statuses':[200]}
                module=SimpleNamespace(endpoint_generate=generate)
                request=SimpleNamespace(api_key='x'*48,model=session['id']+'/web-default',
                    image_b64='',system_text='Translate',user_parts=['<<P0:Hello>>'],history_messages=[],
                    cache_context={'webchatRunId':'fixture-run','operationId':'fixture-op',
                                   'conversationSource':'<<P0:Hello>>'},cancel_check=None)
                with patch.object(translation.native,'module',return_value=module), \
                        patch.object(translation.accounting,'mark_dispatched') as mark:
                    with self.assertRaises(LoginError) as caught:
                        translation.ADAPTER.generate(request)
                    self.assertEqual(caught.exception.code,'login_translation_unsupported')
                    self.assertEqual(caught.exception.status,409)
                    self.assertFalse(caught.exception.requestDispatched)
                    self.assertEqual(calls,[]); mark.assert_not_called()

    def test_adapter_model_list_excludes_unavailable_translation_sessions(self):
        chatgpt=self.bind('login_chatgpt'); claude=self.bind('login_claude'); gemini=self.bind('login_gemini')
        # .69+: testing providers are listed for translation.
        result=translation.ADAPTER.list_models(api_key='x'*48,base_url='')
        self.assertEqual(set(result.models),{s['id']+'/web-default' for s in (chatgpt,claude,gemini)})
        from backend.ai.login import login_provider_registry as registry
        with patch.object(registry,'TRANSLATION_UNDER_IMPROVEMENT',frozenset({'login_chatgpt','login_claude'})):
            result=translation.ADAPTER.list_models(api_key='x'*48,base_url='')
        self.assertEqual(result.models,(gemini['id']+'/web-default',))

    def test_gate_still_checks_owner_before_support_status(self):
        session=self.bind('login_chatgpt')
        with patch.object(routes.login_entitlement,'authorize',return_value='fiction-foreign-owner'):
            with self.assertRaises(LoginError) as caught:
                translation.authorize_model('x'*48,session['id']+'/web-default')
        self.assertEqual(caught.exception.code,'login_session_expired')


if __name__=='__main__': unittest.main()
