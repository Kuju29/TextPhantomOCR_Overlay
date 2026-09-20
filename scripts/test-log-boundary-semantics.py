"""Real telemetry sink and recursive redaction, no provider calls."""
import sys
from pathlib import Path
from collections import defaultdict
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend import logfile
from backend.application.ai_translation import telemetry
safe=logfile.sanitize({'usage':{'inputTokens':123,'cachedInputTokens':None,'thinkingTokens':0,'outputTokens':'secret-value','accessToken':'secret','apiKey':'secret','nested':{'authorization':'secret','token':'secret'}}})
assert safe['usage']['inputTokens']==123
assert safe['usage']['cachedInputTokens'] is None
assert safe['usage']['thinkingTokens']==0
assert safe['usage']['outputTokens']=='<redacted>'
assert safe['usage']['accessToken']==safe['usage']['apiKey']=='<redacted>'
assert set(safe['usage']['nested'].values())=={'<redacted>'}
meta=defaultdict(lambda:0,units=2,rate={},cacheCoordination={},usage={},vision={},omittedIds=['I2_P1'],conversation={'pageCount':2},diagnostics={},provider='test',model='fixture',rateMode='provider_managed')
body={'meta':meta,'translations':[{'id':'I1_P1','text':'ok'}],'memoryDelta':{'characters':[],'glossary':[]}}
for repair in (False,True):
 identity={'compatibilityAlias':repair,'requestedRoute':'/v2/engine/runsextension/repair-runs/r/tasks/t/translate' if repair else '/v2/engine/runsextension/ai/translate'}
 with patch.object(telemetry,'event') as event,patch.object(telemetry.trace,'write'):
  telemetry.emit_success(body=body,missing=['I2_P1'],declined=[],passthrough=[],route_identity=identity,rate_entry={},trace_id='trace',correlation={'imageId':'leader'})
  record=event.call_args.args[1]
  assert record['scope']=='request'
  assert record['retryable'] is False
  assert record['phase']==('repair' if repair else 'initial')
  assert record['outcome']=='partial'
  assert record['languageStatus']=='pending_extension_validation'
print('PASS: cross-page scope, one-pass partial semantics, numeric usage visibility, nested credential redaction')
