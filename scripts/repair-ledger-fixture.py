"""Test-only JSON-line bridge to the production repair ledger (no network)."""
import json, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'api'))
from backend.application.repair_pool.store import RepairStore
from backend.application.repair_pool import state as s
with tempfile.TemporaryDirectory() as tmp:
 db=RepairStore(Path(tmp)/'state.sqlite')
 for line in sys.stdin:
  try:
   data=json.loads(line);run=data['run'];action=data['action'];body=data.get('body') or {}
   rid,token=run['id'],run['token']
   if action=='register':out=db.register(rid,token,body['manifest'],'test')
   elif action=='delete':out=db.delete(rid,token)
   elif action=='':out=db.read(rid,token)
   elif action=='pages':out=db.transact(rid,token,lambda r:s.record_page(r,body))
   elif action=='seal':out=db.transact(rid,token,s.seal)
   elif action=='claim':out=db.transact(rid,token,lambda r:s.claim(r,body))
   elif action=='cancel':out=db.transact(rid,token,s.cancel)
   else:
    _,tid,op=action.split('/')
    if op=='start':out=db.transact(rid,token,lambda r:s.begin(r,tid,body['executor']))
    elif op=='complete':out=db.transact(rid,token,lambda r:s.complete(r,tid,body))
    elif op=='answer':out=db.transact(rid,token,lambda r:s.answer_task(r,tid,body))
    elif op=='fail':out=db.transact(rid,token,lambda r:s.fail(r,tid,body.get('reason','error'),body.get('unknown',False)))
    else:raise ValueError(action)
   print(json.dumps({'ok':True,'value':out},ensure_ascii=False),flush=True)
  except Exception as error:
   print(json.dumps({'ok':False,'code':getattr(error,'code',str(error)),'status':getattr(error,'status',500)}),flush=True)
