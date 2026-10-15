"""Actual run admission: avoid artificial second-turn delay, retain provider429 cooldown."""
import os
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend.ai.login.endpoint import login_endpoint_runs as runs
from backend.ai.login.login_provider_contract import LoginError


def request(run='run',op='op'):
    return SimpleNamespace(cache_context={'webchatRunId':run,'operationId':op,
        'conversationSource':'<<P0:Hello>>'},user_parts=['<<P0:Hello>>'],system_text='Translate',
        model='fiction-session/web-default',image_b64='',history_messages=[],cancel_check=None)


class Spacing(unittest.TestCase):
    def setUp(self):
        runs.clear();self.session={'id':'fiction-session','credential':'fiction-own-account','provider':'login_gemini'}
        self.env=patch.dict(os.environ,{'TP_AI_WIRE_TRACE':'0'});self.env.start()
        os.environ.pop('TP_LOGIN_ENDPOINT_MIN_INTERVAL_MS',None)
        self.current=patch.object(runs.store,'credential_for_session',return_value={'tokens':{'credentials':{}}})
        self.active=patch.object(runs.store,'active_session_ids',return_value={'fiction-session'})
        self.current.start();self.active.start()

    def tearDown(self):
        self.current.stop();self.active.stop();self.env.stop();runs.clear()

    def module(self,calls,fail=False):
        def generate(credentials,prompt,remote,selected,check,dispatch):
            check();calls.append(time.monotonic())
            if fail:
                error=LoginError('login_quota_exceeded','Fixture429',429)
                error.retry_after_ms=50;raise error
            dispatch();remote['thread']='fiction'
            return {'text':'<<P0:สวัสดี>>','completed':True,'statuses':[200],'terminal':'fixture'}
        return SimpleNamespace(endpoint_generate=generate)

    def test_actual_normal_second_turn_has_no_unrequested_spacing(self):
        calls=[];module=self.module(calls)
        runs.generate(self.session,request(op='first'),module)
        result=runs.generate(self.session,request(op='second'),module)
        delay=calls[1]-calls[0]
        print({'normalSecondTurnMs':round(delay*1000,2)},flush=True)
        self.assertLess(delay,.2,'Actual Login turn waits1500ms despite no provider429 requirement')
        self.assertLess(result['account_wait_ms'],200)

    def test_local_trim_keeps_native_thread_and_does_not_repeat_bootstrap(self):
        prompts=[]
        def generate(credentials,prompt,remote,selected,check,dispatch):
            check();dispatch();prompts.append(prompt);remote['thread']='fiction'
            return {'text':'<<P0:สวัสดี>>','completed':True,'statuses':[200],'terminal':'fixture'}
        module=SimpleNamespace(endpoint_generate=generate)
        runs.generate(self.session,request(op='first'),module)
        following=request(op='second');following.cache_context.update(webchatRolloverReason='context_budget',webchatTrimmedTurns=2)
        runs.generate(self.session,following,module)
        self.assertTrue(prompts[0].startswith('Translate'))
        self.assertEqual(prompts[1],'<<P0:Hello>>')

    def test_real_instruction_change_stops_before_dispatch(self):
        calls=[];module=self.module(calls)
        runs.generate(self.session,request(op='first'),module)
        following=request(op='second');following.system_text='Changed instructions'
        with self.assertRaises(LoginError) as caught:runs.generate(self.session,following,module)
        self.assertEqual(caught.exception.code,'login_chat_instructions_changed')
        self.assertEqual(len(calls),1)

    def test_real_rollover_stops_before_dispatch(self):
        calls=[];module=self.module(calls)
        runs.generate(self.session,request(op='first'),module)
        following=request(op='second');following.cache_context['webchatRolloverReason']='provider_changed'
        with self.assertRaises(LoginError) as caught:runs.generate(self.session,following,module)
        self.assertEqual(caught.exception.code,'login_chat_context_changed')
        self.assertEqual(len(calls),1)

    def test_explicit_local_spacing_still_applies_when_configured(self):
        os.environ['TP_LOGIN_ENDPOINT_MIN_INTERVAL_MS']='40';calls=[];module=self.module(calls)
        runs.generate(self.session,request(op='first'),module)
        runs.generate(self.session,request(op='second'),module)
        self.assertGreaterEqual(calls[1]-calls[0],.035)

    def test_provider_retry_after_remains_authoritative_even_with_zero_default(self):
        calls=[]
        with self.assertRaises(LoginError): runs.generate(self.session,request(run='limited'),self.module(calls,True))
        runs.generate(self.session,request(run='following'),self.module(calls))
        self.assertGreaterEqual(calls[1]-calls[0],.045)


if __name__=='__main__':unittest.main()
