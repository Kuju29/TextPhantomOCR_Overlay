"""Wire folder labels describe source pages without changing execution order."""
import json
import os
from pathlib import Path
import sys
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai import wire_trace as w, local_wire_relay as relay

assert w.image_label({'pageIndex':0, 'pageOrder':26}) == 'img-0001'
assert w.image_label({'pageOrder':1}) == 'img-unknown'
assert w.image_label({'pageIndex':False}) == 'img-unknown'
assert w.image_label({'pageIndex':None}) == 'img-unknown'
origins=[{'pageIndex':25},{'pageIndex':0}]
assert w.image_label({'origins':origins,'pageIndex':5}) == 'imgs-0001+0026'
assert origins[0]['pageIndex']==25
assert w.image_label({'origins':[{'pageIndex':0},{}]}) == 'imgs-0001+unknown'
assert 'more6' in w.image_label({'origins':[{'pageIndex':x} for x in range(10)]})
base={'traceId':'trace','operationId':'operation','origins':origins,'attemptKind':'repair'}
assert w.folder_name(base).startswith('imgs-0001+0026--repair--')
assert w.folder_name({**base,'recordKind':'page_summary'}).startswith('imgs-0001+0026--page-summary--')
assert w.folder_name({**base,'operationId':'other'}) != w.folder_name(base)
assert w.folder_name({**base,'operationId':'o'*80+'a'}) != w.folder_name({**base,'operationId':'o'*80+'b'})
assert w.folder_name({**base,'operationId':'a:b'}) != w.folder_name({**base,'operationId':'a_b'})

long={**base,'traceId':'t'*80,'operationId':'o'*80}
assert len(w.folder_name(long,'e'*80)) <= 120
assert w.folder_name(long,'e'*79+'a') != w.folder_name(long,'e'*79+'b')
# Verify the supplied Windows installation path, not arbitrary path depths.
windows_root = r'C:\Users\plan2\Downloads\bot\test\F\TextPhantom-v2\extension\api\logs\ai-wire'
longest_artifact = '01_conversation_origin_validation.json'
assert len(windows_root + '\\' + w.folder_name(long, 'e'*80) + '\\' + longest_artifact) <= 259

with tempfile.TemporaryDirectory() as tmp:
 os.environ['TP_AI_WIRE_TRACE']='1';os.environ['TP_AI_WIRE_TRACE_DIR']=tmp
 token=w.begin({**base,'apiKey':'secret-value'})
 folder=w.active_folder();w.end(token)
 assert 'secret-value' not in (folder/'00_identity.json').read_text()
 identity={**base,'executionKey':'execution'}
 relay_folder=relay.receive({'stage':'trace_started','identity':identity})
 assert relay.receive({'stage':'units','identity':identity,'value':[]})==relay_folder
 assert json.loads((relay_folder/'00_identity.json').read_text())['origins']==origins
 assert relay.receive({'stage':'terminal','identity':identity,'value':{'state':'succeeded'}})==relay_folder
 os.environ['TP_AI_WIRE_TRACE']='0'
 before=set(Path(tmp).iterdir());token=w.begin(base);assert w.active_folder() is None;w.end(token)
 assert set(Path(tmp).iterdir())==before
print('PASS: image index zero, multi-page/unknown, phase, bounded names, uniqueness, stable relay, redaction, disabled trace')
