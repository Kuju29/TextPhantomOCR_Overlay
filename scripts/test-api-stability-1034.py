from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"api"))
import asyncio
from unittest.mock import patch
from fastapi.testclient import TestClient
import backend.main as main
calls=[]
async def warm():calls.append('warmup suppressed')
# .10490: the per-minute Lens-cookie poll is gone (lazy singleflight refresh +
# prefetch on use); the lifespan must start no background cookie task.
assert not hasattr(main,'_cookie_refresh_loop')
with patch.object(main,'_warm_at_boot',warm):
    with TestClient(main.app) as c:
        assert c.get('/health').status_code==200
        r=c.get('/health?detail=true');assert r.status_code==200,r.text
        assert r.json()['components']['queue']['ready'] is True,r.text
        m=c.get('/meta');assert m.status_code==200,m.text
        print('REAL API lifespan + queue/executors startup, health/meta, shutdown passed; external warmup disabled',flush=True)
assert calls==['warmup suppressed'],calls
