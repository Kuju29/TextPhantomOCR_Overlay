"""Bounded, privacy-filtered operational events. No request/response bodies.

Schema tp.diagnostic/1 is shared by Center and extension API. Correlation IDs
are observations, never authentication. Logging failure must not fail business
work. Files are per-process to avoid unsafe cross-process rotation.
"""
from __future__ import annotations
import contextvars
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import io
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import zipfile
from urllib.parse import urlsplit

SCHEMA = 'tp.diagnostic/1'
_CONTEXT = contextvars.ContextVar('tp_diagnostic_context', default=None)
_ID = re.compile(r'^[A-Za-z0-9_.:-]{1,120}$')
_SECRET = re.compile(r'authorization|cookie|password|passwd|secret|credential|signature|verifier|cipher|csrf|bearer|api.?key|gateway.?key|access.?token|refresh.?token|session.?token|step.?up|otp.?code|setup.?code|recovery.?code', re.I)
_CONTENT = {'body', 'payload', 'prompt', 'messages', 'text', 'content', 'html', 'image', 'base64', 'headers', 'sql', 'params', 'parameters', 'locals', 'stacktrace', 'traceback', 'key', 'token', 'code', 'reason_text'}
_MEASUREMENTS = {'input_tokens','output_tokens','total_tokens','reasoning_tokens','cached_tokens','cached_input_tokens','inputTokens','outputTokens','totalTokens','cachedInputTokens','thinkingTokens'}
_EMAIL = re.compile(r'[A-Z0-9.!#$%&\'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}', re.I)

def new_id():
    return secrets.token_hex(16)

def valid_id(value, default=''):
    return value if isinstance(value, str) and _ID.fullmatch(value) else default

def trace_id(value):
    # Accept the legacy extension's opaque IDs, but not arbitrary free text.
    return valid_id(value) or new_id()

def origin(value):
    try:
        u = urlsplit(str(value)); h = u.hostname
        return f'{u.scheme}://{"["+h+"]" if ":" in h else h}{":"+str(u.port) if u.port else ""}' if h and u.scheme in {'http','https'} else ''
    except (ValueError, TypeError):
        return ''

def safe_text(value):
    s = str(value)
    s = re.sub(r'(?i)(?:https?|wss?|file)://[^\s\"\'<>]+', lambda m: (origin(m[0]) or '[url]') + '/[path-omitted]', s)
    s = _EMAIL.sub('[email]', s)
    s = re.sub(r'(?i)\b(?:sk-|rk_|re_|hf_|whsec_)[A-Za-z0-9_-]{8,}', '[credential]', s)
    s = re.sub(r'(?i)\bbearer\s+\S+', 'Bearer [redacted]', s)
    s = re.sub(r'(?i)\b(password|token|key|otp|code|secret|authorization|cookie)\s*[:=]\s*[^\s,;]+', r'\1=[redacted]', s)
    s = re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?', '[credential]', s)
    return s.replace('\x00','').replace('\r','\\r').replace('\n','\\n')[:1500]

def safe(value, *, depth=0):
    if depth > 7: return '[depth-limited]'
    if isinstance(value, dict):
        out = {}
        for raw, v in list(value.items())[:100]:
            k = str(raw)[:100]
            if k in _MEASUREMENTS and (v is None or type(v) in (int,float)):
                out[k] = v
            elif _SECRET.search(k) or k.lower() in _CONTENT:
                out[k] = '[redacted]'
            elif k.lower() in {'email','from_email','to_email','recipient','sender','username','ip','ip_address','page_url','href'}:
                out[k] = '[private]'
            else: out[k] = safe(v, depth=depth+1)
        return out
    if isinstance(value, (list,tuple)):
        return [safe(x,depth=depth+1) for x in value[:100]]
    if value is None or type(value) in (bool,int): return value
    if isinstance(value,float): return value if value == value and abs(value) != float('inf') else None
    return safe_text(value)

def fault(error, root=None):
    """Type, cause types and code locations, never exception text/SQL/locals."""
    result = {'error_type': type(error).__name__, 'frames': []}
    tb = error.__traceback__
    while tb:
        p = Path(tb.tb_frame.f_code.co_filename)
        try:
            if root:
                name = p.resolve().relative_to(Path(root).resolve()).as_posix()
            elif 'backend' in p.parts:
                name = Path(*p.parts[p.parts.index('backend'):]).as_posix()
            elif 'scripts' in p.parts:
                name = Path(*p.parts[p.parts.index('scripts'):]).as_posix()
            else:
                name = p.name
        except (ValueError, OSError): name = p.name
        result['frames'].append({'file': name, 'line': tb.tb_lineno, 'function': tb.tb_frame.f_code.co_name})
        tb = tb.tb_next
    result['frames'] = result['frames'][-12:]
    e = error.__cause__ or error.__context__; causes = []
    while e and len(causes) < 5 and e is not error:
        causes.append(type(e).__name__); e = e.__cause__ or e.__context__
    result['cause_types'] = causes
    result['fingerprint'] = hashlib.sha256(json.dumps(result,sort_keys=True).encode()).hexdigest()[:16]
    return result

def current():
    return dict(_CONTEXT.get() or {})

@contextmanager
def scope(writer=None, **fields):
    ctx = current()
    if writer is not None: ctx['writer'] = writer
    ctx.update(fields)
    token = _CONTEXT.set(ctx)
    try: yield ctx
    finally: _CONTEXT.reset(token)

def update(**fields):
    ctx = current(); ctx.update(fields); _CONTEXT.set(ctx)

def emit(event, *, outcome='info', **data):
    ctx = current(); writer = ctx.pop('writer',None)
    if writer: writer.emit(event,outcome=outcome,context=ctx,**data)

@contextmanager
def span(event, **fields):
    t = time.perf_counter(); emit(event+'.started',**fields)
    try:
        yield
    except BaseException as e:
        emit(event+'.failed',outcome='cancelled' if type(e).__name__ == 'CancelledError' else 'error',
             elapsed_ms=round((time.perf_counter()-t)*1000,2), **fault(e),**fields)
        raise
    else: emit(event+'.completed',outcome='ok',elapsed_ms=round((time.perf_counter()-t)*1000,2),**fields)

def select_job(job_id, **fields):
    ctx = current(); writer = ctx.get('writer')
    parent = writer.lookup_job(job_id) if writer else None
    worker_request = ctx.get('request_id','')
    if parent:
        update(trace_id=parent['trace_id'], initiating_request_id=parent['request_id'], job_id=job_id,
               worker_request_id=worker_request)
    else:
        update(job_id=job_id, trace_id=new_id(), initiating_request_id='', worker_request_id=worker_request)
    emit('outbox.selected', correlation_found=bool(parent), **fields)

def summarize_events(rows):
    """Index observed evidence, not a diagnosis inferred from missing rows."""
    from collections import Counter
    events=Counter(); outcomes=Counter(); errors=Counter(); traces={}; timeline=[]
    for row in rows:
        data=row.get('data') if isinstance(row.get('data'),dict) else {}
        event=row.get('event',''); outcome=row.get('outcome','')
        events[event]+=1; outcomes[outcome]+=1
        if data.get('error_code'): errors[str(data['error_code'])]+=1
        tid=row.get('trace_id') or ''
        if tid:
            item=traces.setdefault(tid,{'trace_id':tid,'event_count':0,'first_ms':row.get('ts_ms'),
                'last_ms':row.get('ts_ms'),'services':set(),'request_ids':set(),'job_ids':set(),'error_codes':set(),'observed_outcomes':set()})
            item['event_count']+=1; item['last_ms']=row.get('ts_ms'); item['services'].add(row.get('service',''))
            item['observed_outcomes'].add(outcome)
            for target,value in [('request_ids',row.get('request_id')),('job_ids',row.get('job_id') or data.get('job_id')),('error_codes',data.get('error_code'))]:
                if value: item[target].add(value)
        detail={k:data[k] for k in ('method','path','reason','error_code','error_type','http_status','status','state','entity',
            'job_id','provider_message_id','attempt','queue_wait_ms','elapsed_ms','wait_ms','charged_tp','cost_usd') if k in data}
        timeline.append(f"{row.get('ts','')} {row.get('service','')} [{row.get('component','')}] trace={tid or '-'} request={row.get('request_id','-')} {event} => {outcome} "
                        +json.dumps(safe(detail),ensure_ascii=False,separators=(',',':')))
    index=[]
    for value in traces.values(): index.append({k:sorted(v) if isinstance(v,set) else v for k,v in value.items()})
    return {'event_counts':dict(events),'outcome_counts':dict(outcomes),'error_code_counts':dict(errors),'traces':index}, timeline

class EventWriter:
    def __init__(self, directory, *, service, release, workspace='', enabled=True,
                 max_file_bytes=4*1024*1024, max_total_bytes=64*1024*1024, keep_days=7):
        self.directory = Path(directory)
        self.service, self.release, self.workspace = service, release, workspace
        self.enabled = bool(enabled); self.boot_id = new_id(); self.pid=os.getpid()
        self.max_file_bytes=max_file_bytes; self.max_total_bytes=max_total_bytes; self.keep_days=keep_days
        self.lock = threading.RLock(); self.seq=0; self.part=0
        self.written=0; self.write_failures=0; self.last_failure=''; self._last_notice=0.0
        self._last_prune=0.0; self.pruned_files=0; self._links_ready=False
        self.started_at_ms=int(time.time()*1000)
        self._links_cache={}
        self.prefix=f'events-{datetime.now(timezone.utc):%Y%m%d}-{self.pid}-{self.boot_id[:8]}'
        self.file=self.directory / (self.prefix+'-0000.jsonl')
        if self.enabled:
            try:
                self.directory.mkdir(parents=True, exist_ok=True); self.directory.chmod(0o700)
                self._prune()
                with self._links() as db:
                    db.execute('CREATE TABLE IF NOT EXISTS links (job_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, request_id TEXT NOT NULL, created_ms INTEGER NOT NULL)')
                    db.execute('DELETE FROM links WHERE created_ms < ?', (self.started_at_ms-7*86400000,))
                self._links_ready=True
            except Exception as e: self._failed(e)
    def _links(self):
        # Separate diagnostics database: never alter or lock the business ledger.
        conn=sqlite3.connect(self.directory/'correlation.sqlite3',timeout=0.05)
        conn.execute('PRAGMA journal_mode=WAL')
        return _Connection(conn)
    def _failed(self,e):
        self.write_failures+=1; self.last_failure=type(e).__name__
        now=time.monotonic()
        if now-self._last_notice>60:
            self._last_notice=now
            try: print(f'[TP Diagnostics] write_failed service={self.service} error_type={type(e).__name__}; some evidence may be missing',file=sys.stderr)
            except Exception: pass
    def _prune(self):
        now=time.time(); total=0; entries=[]
        for f in self.directory.glob('events-*.jsonl'):
            if f.is_symlink() or not f.is_file(): continue
            st=f.stat()
            if now-st.st_mtime>self.keep_days*86400 and f!=self.file:
                f.unlink(); self.pruned_files+=1; continue
            entries.append((st.st_mtime,f,st.st_size)); total+=st.st_size
        for _,f,size in sorted(entries):
            if total<=self.max_total_bytes: break
            if f!=self.file:
                f.unlink(missing_ok=True); total-=size; self.pruned_files+=1
        self._last_prune=time.monotonic()
    def emit(self,event, *, outcome='info', context=None, **data):
        if not self.enabled: return False
        try:
            ctx={k:v for k,v in (context or {}).items() if k!='writer'}
            stamp=int(time.time()*1000)
            with self.lock:
                self.seq+=1
                record={'schema':SCHEMA,'ts':datetime.fromtimestamp(stamp/1000,timezone.utc).isoformat(timespec='milliseconds'),
                    'ts_ms':stamp,'service':self.service,'release':self.release,'workspace':self.workspace,
                    'boot_id':self.boot_id,'pid':self.pid,'seq':self.seq,
                    **safe(ctx),'event':valid_id(event,'invalid_event'),'outcome':valid_id(outcome,'info'),'data':safe(data)}
                line=json.dumps(record,ensure_ascii=False,allow_nan=False,separators=(',',':'))+'\n'
                if self.file.exists() and self.file.stat().st_size+len(line.encode())>self.max_file_bytes:
                    self.part+=1; self.file=self.directory/(self.prefix+f'-{self.part:04d}.jsonl')
                self.directory.mkdir(parents=True,exist_ok=True)
                with self.file.open('a',encoding='utf-8') as h: h.write(line)
                try: self.file.chmod(0o600)
                except OSError: pass
                self.written+=1
                if time.monotonic()-self._last_prune>30 or self.written%500==0:
                    try: self._prune()
                    except OSError as e: self._failed(e)
            return True
        except Exception as e:
            self._failed(e)
            return False
    def link_job(self,job_id,ctx=None):
        ctx=ctx or current(); t=valid_id(ctx.get('trace_id')); j=valid_id(job_id)
        if not self.enabled or not t or not j: return
        entry={'trace_id':t,'request_id':valid_id(ctx.get('request_id'))}
        with self.lock:
            self._links_cache[j]=entry
            if len(self._links_cache)>20000: self._links_cache.pop(next(iter(self._links_cache)))
        if not self._links_ready: return
        try:
            with self._links() as db:
                db.execute('INSERT OR IGNORE INTO links VALUES (?,?,?,?)',(j,t,entry['request_id'],int(time.time()*1000)))
                db.execute('DELETE FROM links WHERE job_id IN (SELECT job_id FROM links ORDER BY created_ms DESC LIMIT -1 OFFSET 20000)')
        except Exception as e: self._failed(e)
    def lookup_job(self,job_id):
        j=valid_id(job_id)
        if j in self._links_cache: return self._links_cache[j]
        if not self.enabled or not self._links_ready or not j: return None
        try:
            with self._links() as db: row=db.execute('SELECT trace_id,request_id FROM links WHERE job_id=?',(j,)).fetchone()
            return {'trace_id':row[0],'request_id':row[1]} if row else None
        except Exception as e: self._failed(e); return None
    def health(self):
        return {'enabled':self.enabled,'written':self.written,'write_failures':self.write_failures,
                'last_failure_type':self.last_failure or None,'boot_id':self.boot_id,'pid':self.pid,
                'retention_days':self.keep_days,'max_total_bytes':self.max_total_bytes,'pruned_files':self.pruned_files,
                'schema':SCHEMA,'file':self.file.name,'directory':str(self.directory)}
    def read_events(self, *, hours=24, trace='', limit=100000, byte_limit=48*1024*1024):
        cutoff=int(time.time()*1000)-int(hours*3600000)
        out=[]; size=0; truncated=False; malformed=0; source_files=[]
        try:
            candidates=sorted((f for f in self.directory.glob('events-*.jsonl') if f.is_file() and not f.is_symlink()),key=lambda f:f.stat().st_mtime,reverse=True)
            for f in candidates:
                if f.stat().st_mtime*1000<cutoff: continue
                source_files.append(f.name)
                # Each file is bounded. Read latest first for a truthful tail on overflow.
                with f.open(encoding='utf-8') as h: lines=h.readlines()
                for line in reversed(lines):
                    try: record=json.loads(line)
                    except (ValueError,UnicodeError): malformed+=1; continue
                    if not isinstance(record,dict) or record.get('ts_ms',0)<cutoff: continue
                    if trace and trace not in {record.get('trace_id'),record.get('request_id'),record.get('job_id'),record.get('operation_id'),record.get('data',{}).get('job_id'),record.get('data',{}).get('operation_id')}: continue
                    if len(out)>=limit or size+len(line.encode())>byte_limit: truncated=True; break
                    out.append(record); size+=len(line.encode())
                if truncated: break
        except Exception as e:
            self._failed(e); truncated=True
        out.sort(key=lambda x:(x.get('ts_ms',0),x.get('boot_id',''),x.get('seq',0)))
        return out,{'truncated':truncated,'malformed_lines':malformed,'source_files':source_files,'event_count':len(out),
                    'from_ms':cutoff,'exported_at_ms':int(time.time()*1000),'bytes':size}
    def bundle(self, *, hours=24, trace='', snapshot=None):
        rows,selection=self.read_events(hours=hours,trace=trace)
        manifest={'schema':SCHEMA,'service':self.service,'release':self.release,'workspace':self.workspace,
                  'selection':selection,'logging':self.health(),
                  'privacy':'No raw bodies, email addresses, keys, passwords, OTP, cookies, sessions, images, or databases are included.',
                  'limitations':['Only events recorded after this release started are available.',
                    'Client events are untrusted observations, not proof a server performed an operation.',
                    'provider_accepted is not inbox delivery. No delivery confirmation is inferred.',
                    'Clock differences between machines can affect merged timestamp ordering. Use trace/request/job IDs.',
                    'Retention, overflow, write failures, process termination or an offline browser may leave evidence gaps.']}
        # The local absolute log directory is useful in UI, but not needed in exports.
        manifest['logging'].pop('directory',None)
        rows=[safe(row) for row in rows]
        index,timeline=summarize_events(rows)
        b=io.BytesIO()
        with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:
            z.writestr('manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2))
            z.writestr('events.jsonl',''.join(json.dumps(safe(r),ensure_ascii=False,separators=(',',':'))+'\n' for r in rows))
            z.writestr('snapshot.json',json.dumps(safe(snapshot or {}),ensure_ascii=False,indent=2))
            z.writestr('trace-index.json',json.dumps(index,ensure_ascii=False,indent=2))
            z.writestr('timeline.txt','Observed events only. provider_accepted is not inbox delivery. Read manifest.json for evidence limits.\n'+'\n'.join(timeline)+'\n')
        return b.getvalue()

class _Connection:
    def __init__(self,conn): self.conn=conn
    def __enter__(self): return self.conn
    def __exit__(self,t,v,tb):
        try:
            if t is None: self.conn.commit()
            else: self.conn.rollback()
        finally: self.conn.close()

class DiagnosticsMiddleware:
    """Pure ASGI instrumentation: never reads bodies or buffers streaming output."""
    def __init__(self, app, *, writer): self.app,self.writer=app,writer
    async def __call__(self,scope_,receive,send):
        if scope_['type'] not in {'http','websocket'}: return await self.app(scope_,receive,send)
        h={k.lower():v.decode('latin1') for k,v in scope_.get('headers',[])}
        rid=new_id(); tid=trace_id(h.get(b'x-tp-trace-id')); parent=valid_id(h.get(b'x-tp-request-id'))
        state=scope_.setdefault('state',{}); state['request_id']=rid; state['trace_id']=tid
        path=scope_.get('path',''); method=scope_.get('method','WEBSOCKET')
        ignored=path.endswith(('/v1/logs','/v1/trace','/diagnostics/client'))
        status=None; sent=0; received=0; disconnected=False; started=time.perf_counter()
        fields={'trace_id':tid,'request_id':rid,'parent_request_id':parent,
                'component':'http','client_version':valid_id(h.get(b'x-tp-client-version'))}
        async def recv():
            nonlocal received,disconnected
            msg=await receive()
            if msg['type']=='http.request': received+=len(msg.get('body',b''))
            if msg['type'] in {'http.disconnect','websocket.disconnect'}: disconnected=True
            return msg
        async def snd(msg):
            nonlocal status,sent
            if msg['type']=='http.response.start':
                status=msg['status']; headers=[(k,v) for k,v in msg.get('headers',[]) if k.lower() not in {b'x-request-id',b'x-tp-trace-id'}]
                msg={**msg,'headers':headers+[(b'x-request-id',rid.encode()),(b'x-tp-trace-id',tid.encode())]}
            if msg['type']=='http.response.body': sent+=len(msg.get('body',b''))
            await send(msg)
        with scope(self.writer,**fields):
            if not ignored: emit('http.request.started',method=method,path=safe_text(path),auth_present=b'authorization' in h,cookie_present=b'cookie' in h)
            try: await self.app(scope_,recv,snd)
            except BaseException as e:
                emit('http.request.exception',outcome='cancelled' if type(e).__name__=='CancelledError' else 'error',
                     method=method,path=safe_text(path),**fault(e))
                raise
            finally:
                if not ignored:
                    emit('http.request.completed',outcome='ok' if status is not None and status<400 else 'error',
                         method=method,path=safe_text(path),http_status=status,elapsed_ms=round((time.perf_counter()-started)*1000,2),
                         received_bytes=received,sent_bytes=sent,client_disconnected=disconnected,
                         error_code=state.get('diagnostic_error'),completion='response_sent' if status else 'no_response')
