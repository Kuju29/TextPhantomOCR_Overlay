"""stdin fixture helper for test-audit-wire.mjs; ASGI only, no socket/provider."""
import sys, json, tempfile, os, asyncio
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
def main():
    value=json.load(sys.stdin)
    with tempfile.TemporaryDirectory() as tmp:
        os.environ.update(TP_TRACE='1', TP_TRACE_DIR=tmp, TP_LOG_DIR=tmp)
        from backend import trace
        from backend.api.routes.logs import router
        from backend.diagnostic_schema import sanitize_audit
        from fastapi import FastAPI
        import httpx
        trace._ROOT=Path(tmp)
        app=FastAPI();app.include_router(router)
        packet=value['shipment'];packet['traceSession']=trace.session_id()
        async def send():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
                a=await c.post('/v1/trace',json=packet);b=await c.post('/v1/trace',json=packet)
                assert a.status_code==200,a.text
                assert b.status_code==200,b.text
                return b.json()
        repeated=asyncio.run(send());trace.flush()
        events=[json.loads(line) for f in Path(tmp).glob('*.jsonl') for line in f.read_text(encoding='utf8').splitlines() if line.strip()]
        rows=[v for v in events if v.get('d',{}).get('schema')=='tp.audit/1']
        safe=[sanitize_audit(v) for v in value['vectors']]
        print(json.dumps(dict(events=len(rows),replayedWritten=repeated['written'],
            everyId=all(v['d']['rows'][0]['id']=='p3' and v['d']['rows'][0]['ref']=='p8' and v['d']['before']['outputTarget']==180 and v['d']['after']['outputTarget']==203 for v in rows),
            secretFree='PRIVATE_' not in json.dumps(events),schemaParity=safe==value['expected'])))
if __name__=='__main__':main()
