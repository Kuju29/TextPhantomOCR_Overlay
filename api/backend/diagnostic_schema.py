"""Bounded typed diagnostics. Cross-runtime fixtures enforce the JS wire contract."""
import json
import math
import re
from pathlib import Path
_TABLE = {k: set(v) for k, v in json.loads(Path(__file__).with_name('diagnostic-schema.json').read_text()).items()}
_ID = re.compile(r'^(?:[a-f0-9]{16,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|t[a-z0-9]{8,40}|(?:p|g|P|R|c|i)\d+(?:[-:]\w{1,12})?|tr:\d+|(?:ai|repair):[a-f0-9-]{16,64}(?::[a-zA-Z0-9-]{1,64}){0,5})$', re.ASCII)
def _id(v):
    return v if isinstance(v,str) and len(v)<=240 and _ID.fullmatch(v) else None
def _part(v, depth=0):
    if not isinstance(v,dict) or depth>3: return {}
    out={}
    for k,x in list(v.items())[:40]:
        if k in _TABLE['numeric']: out[k]=math.floor(x*1000+0.5)/1000 if type(x) in (int,float) and math.isfinite(x) else None
        elif k in _TABLE['ids']: out[k]=_id(x)
        elif k=='ids' and isinstance(x,list): out[k]=[_id(i) for i in x[:12]]
        elif k in ('before','after','timing','counts','planned','effective','observed','scope','evidence'): out[k]=_part(x,depth+1)
        elif k=='rows' and isinstance(x,list): out[k]=[_part(row,depth+1) for row in x[:12]]
        elif k=='reason': out[k]=x if isinstance(x,str) and x in _TABLE['reasons'] else 'unknown'
        elif k=='phase': out[k]=x if isinstance(x,str) and x in _TABLE['phases'] else 'waiting'
        elif k=='contract': out[k]=x if isinstance(x,str) and x in _TABLE['contracts'] else 'unknown'
        elif k in ('persistence','decisionStatus'): out[k]=x if isinstance(x,str) and x in _TABLE['states'] else 'unknown'
        elif k in ('sourceKind','engine','route','thinking','direction','effectiveFrom'):
            allowed={'sourceKind':('original','translated','ai'),'engine':('extension','api'),
                'route':('direct-local','server','api','extension'),'thinking':('on','off','auto','default','unknown'),
                'direction':('h','v','tilted','unknown'),'effectiveFrom':('next_request','current_request','current_image','next_job','unknown')}
            out[k]=x if isinstance(x,str) and x in allowed[k] else 'unknown'
        elif k in ('changed','complete','pageImage','memoryEnabled','traceEnabled','rotated','eraseEnabled','unlimited'): out[k]=x if type(x) is bool else None
    return out
def sanitize_audit(value):
    if not isinstance(value,dict) or value.get('schema')!='tp.audit/1': return None
    ev=value.get('event')
    return {'schema':'tp.audit/1','event':ev if isinstance(ev,str) and ev in _TABLE['events'] else 'unknown',**_part(value)}
