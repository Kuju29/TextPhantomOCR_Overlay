"""Actual Paid admission/executor cancellation regression; synthetic translate only.

No HTTP, live provider, account or credential. Default source is this packaged
app; --app-root or TP_PAID_APP_ROOT can select a separately supplied historical
app. --immutable-admission-source reads an explicit provider_execution.py source
in memory, leaving the chosen app untouched.
"""
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
import os
import sys
import threading
import unittest
from unittest.mock import patch

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--app-root', default=os.environ.get('TP_PAID_APP_ROOT'))
parser.add_argument('--immutable-admission-source', type=Path)
options = parser.parse_args()
ROOT = Path(options.app_root).resolve() if options.app_root else Path(__file__).resolve().parents[1]
version = str(ROOT)
sys.path.insert(0, str(ROOT / 'api'))
from backend.application.ai_translation import provider_execution as execution
from backend.application.ai_translation.context import TranslationContext
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation_paths.mode import descriptor
from backend.ai.translation_paths import store as conversation_store
from backend.jobs.admission import AdmissionGate
from fastapi import HTTPException
if options.immutable_admission_source:
    original = options.immutable_admission_source.read_bytes()
    exec(compile(original, str(options.immutable_admission_source), 'exec'), execution.__dict__)


async def event_seen(event):
    for _ in range(200):
        if event.is_set():
            return
        await asyncio.sleep(.005)
    raise AssertionError('Synthetic invocation did not reach the executor')


class ApiLanes(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.release = threading.Event()
        self.started = threading.Event()
        self.sent = []
        self.pool = ThreadPoolExecutor(max_workers=3)
        self.state = SimpleNamespace(ai_executor=self.pool,
            ai_admission_gate=AdmissionGate(2, max_waiters=8, max_wait_sec=1))
        self.request = SimpleNamespace(app=SimpleNamespace(state=self.state))
        self.tasks = []

        def invoke(marked, target, ai, **kwargs):
            assert conversation_store.current().key, 'actual private Conversation lane must reach the executor'
            self.sent.append(marked)
            if marked == 'blocked':
                self.started.set()
                if not self.release.wait(3):
                    raise AssertionError('Synthetic blocked call was not released')
            return {'aiTextFull': marked, 'meta': {'provider': 'paid', 'model': 'qa/test'}}
        self.mock = patch.object(execution, 'translate', invoke)
        self.mock.start()

    async def asyncTearDown(self):
        self.release.set()
        for task in self.tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.mock.stop()
        self.pool.shutdown(wait=True)

    def launch(self, marked, credential='owner-a', cancel_check=None):
        ctx = TranslationContext(request=self.request, payload={}, request_context={},
            units=({'id': 'P0', 'text': marked},), target_lang='th',
            config=AiConfig(api_key=credential, provider='paid', model='qa/test',
                translation_mode='conversation', conversation=descriptor(
                    {'documentId': marked, 'webchatRunId': 'qa-' + marked},
                    context={'tp_tab_session': 'synthetic-tab-owner'})),
            marked=marked, trace_id='qa-lanes',
            correlation={}, route_identity={}, requested_route='runsextension',
            resolved_provider='paid', resolved_model='qa/test', rate={'enabled': False},
            unlimited=False, identity=credential, prompt_meta={}, cancel_check=cancel_check)
        task = asyncio.create_task(execution.run(ctx, rate_wait_ms=0))
        self.tasks.append(task)
        return task

    async def queued_wallet_seen(self):
        for _ in range(200):
            queues = getattr(self.state, 'paid_wallet_gate', None)
            if queues and any(entry['refs'] == 2 for entry in queues.queues.values()):
                return
            await asyncio.sleep(.005)
        self.fail('Synthetic waiter did not reach actual WalletGate acquisition')

    async def test_same_wallet_waits_outside_ai_slot_while_other_owner_runs(self):
        first = self.launch('blocked')
        await event_seen(self.started)
        second = self.launch('queued')
        other = self.launch('other', 'owner-b')
        self.assertEqual((await asyncio.wait_for(other, 1)).result['aiTextFull'], 'other')
        self.assertFalse(second.done())
        self.assertEqual(self.state.ai_admission_gate.stats().running, 1)
        self.assertNotIn('queued', self.sent)
        self.release.set()
        await asyncio.wait_for(asyncio.gather(first, second), 1)
        self.assertEqual(self.state.ai_admission_gate.stats().running, 0)
        self.assertEqual(self.state.paid_wallet_gate.queues, {})

    async def test_task_cancellation_keeps_ownership_until_executor_exits(self):
        first = self.launch('blocked')
        await event_seen(self.started)
        first.cancel()
        await asyncio.sleep(.03)
        self.assertFalse(first.done(), 'executor must drain before lane release')
        second = self.launch('queued')
        other = self.launch('other', 'owner-b')
        await asyncio.wait_for(other, 1)
        self.assertFalse(second.done())
        self.assertEqual(self.state.ai_admission_gate.stats().running, 1)
        self.release.set()
        with self.assertRaises(asyncio.CancelledError):
            await first
        await asyncio.wait_for(second, 1)
        self.assertEqual(self.state.ai_admission_gate.stats().running, 0)
        self.assertEqual(self.state.paid_wallet_gate.queues, {})

    async def test_ordinary_queued_cancellation_returns_before_predecessor(self):
        first = self.launch('blocked')
        await event_seen(self.started)
        cancelled = threading.Event()
        second = self.launch('queued', cancel_check=cancelled.is_set)
        await self.queued_wallet_seen()
        cancelled.set()
        # Deliberately observe rather than cancelling the asyncio task: ordinary
        # batch cancellation reaches ctx.cancel_check, unlike stream disconnect.
        done, _ = await asyncio.wait((second,), timeout=.2)
        self.assertIn(second, done,
            'ordinary cancellation remained behind the WalletGate lock owner')
        with self.assertRaises(HTTPException) as failure:
            await second
        self.assertEqual(failure.exception.status_code, 409)
        self.assertNotIn('queued', self.sent)
        self.release.set()
        await first

    async def test_repeated_task_cancel_releases_queued_wallet_ref(self):
        first = self.launch('blocked')
        await event_seen(self.started)
        second = self.launch('queued')
        await self.queued_wallet_seen()
        self.assertEqual(next(iter(self.state.paid_wallet_gate.queues.values()))['refs'], 2)
        second.cancel()
        asyncio.get_running_loop().call_soon(second.cancel)
        await asyncio.gather(second, return_exceptions=True)
        self.assertEqual(next(iter(self.state.paid_wallet_gate.queues.values()))['refs'], 1,
            'a repeatedly cancelled waiter must release its pending WalletGate reference')
        self.assertNotIn('queued', self.sent)
        self.release.set()
        await first
        self.assertEqual(self.state.paid_wallet_gate.queues, {})

    async def test_failing_queued_checker_releases_its_acquire(self):
        first = self.launch('blocked')
        await event_seen(self.started)
        fail_checker = threading.Event()
        def checker():
            if fail_checker.is_set():
                raise RuntimeError('Synthetic cancellation checker failed')
            return False
        second = self.launch('queued', cancel_check=checker)
        await self.queued_wallet_seen()
        fail_checker.set()
        done, _ = await asyncio.wait((second,), timeout=.2)
        self.assertIn(second, done)
        with self.assertRaises(RuntimeError):
            await second
        self.assertEqual(next(iter(self.state.paid_wallet_gate.queues.values()))['refs'], 1)
        self.assertNotIn('queued', self.sent)
        self.release.set()
        await first
        self.assertEqual(self.state.paid_wallet_gate.queues, {})

    async def test_repeated_running_task_cancel_drains_and_releases_once(self):
        first = self.launch('blocked')
        await event_seen(self.started)
        first.cancel()
        first.cancel()
        await asyncio.sleep(.03)
        self.assertFalse(first.done())
        self.assertEqual(self.state.ai_admission_gate.stats().running, 1)
        self.release.set()
        asyncio.get_running_loop().call_soon(first.cancel)
        with self.assertRaises(asyncio.CancelledError):
            await first
        self.assertEqual(self.state.ai_admission_gate.stats().running, 0)
        self.assertEqual(self.state.paid_wallet_gate.queues, {})
        follow = self.launch('follow')
        self.assertEqual((await asyncio.wait_for(follow, 1)).result['aiTextFull'], 'follow')


if __name__ == '__main__':
    print('API lane version:', version, flush=True)
    unittest.main(argv=[sys.argv[0]], verbosity=2)
