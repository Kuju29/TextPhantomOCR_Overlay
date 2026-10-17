""".10485 API job queue: delivered results drop image bytes after a short grace.

2026.10.16.3: the former per-caller COUNT cap (503 busy at 3/200 queued jobs) is
gone by the owner's rule -- waiting is bounded by memory only (QueueBytesFull)."""
import asyncio
import sys
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.config import settings
from backend.jobs import queue as queue_module
from backend.jobs.queue import JobQueue, QueueBytesFull, QueueFull, DELIVERED_IMAGE_GRACE_SEC
from backend.application import legacy_translation

IMAGE = 'data:image/png;base64,' + 'A' * 200_000


async def main():
    q = JobQueue(lambda payload: {})
    payload = {'mode': 'lens_text', 'source': 'direct', 'src': 'https://x.invalid/a.png'}

    # No per-caller count cap: one tab may queue many jobs; others still get in.
    for _ in range(250):
        await q.enqueue(payload, caller_scope='o:tab-a')
    await q.enqueue(payload, caller_scope='o:tab-b')
    assert not hasattr(queue_module, 'CallerQueueFull')
    assert issubclass(QueueBytesFull, QueueFull), 'memory guard keeps the 503 + Retry-After route contract'

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
    print('PASS .10485 job queue: no job-count cap (memory guard only) and delivered image bytes released after 120 s grace')


asyncio.run(main())
