""".10485 API job queue: delivered results drop image bytes after a short grace; per-caller queue cap (503 busy)."""
import asyncio
import sys
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.config import settings
from backend.jobs import queue as queue_module
from backend.jobs.queue import JobQueue, QueueFull, CallerQueueFull, DELIVERED_IMAGE_GRACE_SEC
from backend.application import legacy_translation

IMAGE = 'data:image/png;base64,' + 'A' * 200_000


async def main():
    q = JobQueue(lambda payload: {})
    payload = {'mode': 'lens_text', 'source': 'direct', 'src': 'https://x.invalid/a.png'}

    # Per-caller cap: the caller's queued jobs are capped, other callers still get in.
    with patch.object(queue_module, 'settings', replace(settings, max_queue_per_caller=3)):
        for _ in range(3):
            await q.enqueue(payload, caller_scope='o:tab-a')
        try:
            await q.enqueue(payload, caller_scope='o:tab-a')
            raise AssertionError('caller cap not enforced')
        except CallerQueueFull as exc:
            assert isinstance(exc, QueueFull), 'same 503 + Retry-After route contract'
            assert str(exc).startswith('server busy'), 'client maps it to SERVER_BUSY'
            assert exc.code == 'queue_caller_limit'
        await q.enqueue(payload, caller_scope='o:tab-b')

    # Finished job: result kept intact until delivered, then image bytes released after the grace window.
    job = (await q.enqueue(payload, caller_scope='o:tab-c'))['id']
    q._jobs[job].update(status='done', result={'imageDataUri': IMAGE, 'translations': ['สวัสดี'], 'perf': {}})
    q.release_delivered_images(now=10**12)
    assert q._jobs[job]['result']['imageDataUri'] == IMAGE, 'never released before delivery'
    polled = await legacy_translation.poll_jobs(q, [job], wait=0, caller_scope='o:tab-c', max_inline=1)
    assert polled['jobs'][0]['result']['imageDataUri'] == IMAGE
    assert 'delivered_at' not in polled['jobs'][0] and 'image_released' not in polled['jobs'][0], 'internal keys hidden'
    delivered = q._jobs[job]['delivered_at']
    assert q.release_delivered_images(now=delivered + DELIVERED_IMAGE_GRACE_SEC - 1) == 0, 'grace window keeps bytes'
    again = q.get_scoped(job, caller_scope='o:tab-c')
    assert again['result']['imageDataUri'] == IMAGE, 're-poll inside grace still gets the image'
    assert q.release_delivered_images(now=delivered + DELIVERED_IMAGE_GRACE_SEC) == len(IMAGE)
    late = q.get_scoped(job, caller_scope='o:tab-c')
    assert late['status'] == 'done' and late['result']['translations'] == ['สวัสดี'], 'text result kept'
    assert late['result']['imageDataUri'] == '' and late['result']['imageReleased'] is True, 'explicit release marker'

    # A result that was not inlined in a batch poll is not "delivered".
    other = (await q.enqueue(payload, caller_scope='o:tab-c'))['id']
    third = (await q.enqueue(payload, caller_scope='o:tab-c'))['id']
    for jid in (other, third):
        q._jobs[jid].update(status='done', result={'imageDataUri': IMAGE})
    out = await legacy_translation.poll_jobs(q, [other, third], wait=0, caller_scope='o:tab-c', max_inline=1)
    assert out['jobs'][1].get('result_ready') is True
    assert 'delivered_at' in q._jobs[other] and 'delivered_at' not in q._jobs[third]
    print('PASS .10485 job queue: per-caller cap (503 server busy) and delivered image bytes released after 120 s grace')


asyncio.run(main())
