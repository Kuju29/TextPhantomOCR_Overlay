"""Dispatch the contiguous ready prefix of registered webpage reservations.
OCR stays parallel. Terminal reservations unblock successors immediately;
unrelated documents do not share a lock during provider work.
"""
from __future__ import annotations
from collections import OrderedDict
from concurrent.futures import Future, TimeoutError
from contextvars import copy_context
from dataclasses import dataclass, field
import hashlib
import threading
import time
import uuid
from .mode import scope_material

@dataclass(eq=False)
class Ticket:
    group: object
    ai: object
    target: str
    order: int
    units: list | None = None
    options: dict = field(default_factory=dict)
    offset: int = 0
    values: dict = field(default_factory=dict)
    receipts: list = field(default_factory=list)
    refs: list = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    future: Future = field(default_factory=Future)
    finished: bool = False
    context: object = None
    in_flight: bool = False
    wait_reason: str = ""
    wait_since: float = 0.0
    previous_wait_ms: float = 0.0
    source_wait_ms: float = 0.0
    ready_order: int = 0

class ReadyRegistry:
    def __init__(self,dispatch,choose,project,emit):
        self.lock=threading.RLock();self.groups={};self.profiles=OrderedDict()
        self.dispatch,self.choose,self.project,self.emit=dispatch,choose,project,emit

    def _waiting(self,t,reason):
        now=time.monotonic()
        if t.wait_reason==reason:return
        elapsed=max(0,(now-t.wait_since)*1000)
        if t.wait_reason=='waiting_for_previous_turn':t.previous_wait_ms+=elapsed
        elif t.wait_reason=='waiting_for_source_order':t.source_wait_ms+=elapsed
        t.wait_reason=reason;t.wait_since=now

    def _ordered(self,g):
        def key(t):
            index=(t.ai.conversation or {}).get('pageIndex')
            return (index if type(index) is int and 0 <= index < 10000000 else t.order,t.order)
        return sorted((t for t in g['tickets'] if not t.finished),key=key)

    def _refresh_waits(self,g):
        blocked=False
        for t in self._ordered(g):
            if t.units is None:blocked=True;continue
            reason='' if t.in_flight else 'waiting_for_previous_turn' if g['running'] else 'waiting_for_source_order' if blocked else ''
            self._waiting(t,reason)

    def reserve(self,ai,target):
        material=scope_material(ai,target)
        key=hashlib.sha256((material or str(uuid.uuid4())).encode()).hexdigest()
        with self.lock:
            g=self.groups.setdefault(key,{'key':key,'tickets':[],'running':False,'sequence':0,'ready_sequence':0})
            g['sequence']+=1
            t=Ticket(g,ai,target,g['sequence']);g['tickets'].append(t)
            return t

    def finish(self,t,error=None):
        with self.lock:
            if t.finished:return
            self._waiting(t,'');t.finished=True
            if t in t.group['tickets']:t.group['tickets'].remove(t)
            if not t.future.done():
                if error:t.future.set_exception(error)
                elif t.units is not None:
                    try:t.future.set_result(self.project(t))
                    except Exception as exc:t.future.set_exception(exc)
                else:t.future.set_result(None)
            self._start(t.group)

    def submit(self,t,units,**options):
        with self.lock:
            if t.units is not None or t.finished:raise ValueError('Conversation page already submitted')
            t.units=list(units);t.options=options;t.context=copy_context()
            t.group['ready_sequence']+=1;t.ready_order=t.group['ready_sequence']
            self._start(t.group)
        while True:
            if options.get('cancel_check') and options['cancel_check']():
                self.finish(t,RuntimeError('cancelled'))
            try:return t.future.result(timeout=.1)
            except TimeoutError:continue  # Observe cancellation while a real predecessor is running.

    def _start(self,g):
        self._refresh_waits(g)
        if g['running']:return
        live=[t for t in g['tickets'] if not t.finished]
        if not live:self.groups.pop(g['key'],None);return
        if self._ordered(g)[0].units is None:return
        g['running']=True
        threading.Thread(target=lambda:self._drain(g),name='tp-ready-conversation',daemon=True).start()

    def _drain(self,g):
        try:
            while True:
                with self.lock:
                    ready=[]
                    candidates=self._ordered(g)
                    for t in candidates:
                        if t.units is None:break
                        if not t.units:self.finish(t);continue
                        if ready and (t.options['compat']!=ready[0].options['compat'] or t.ai.image_b64 or ready[0].ai.image_b64):break
                        if any(r.ai.conversation.get('pageId')==t.ai.conversation.get('pageId') for r in ready):break
                        ready.append(t)
                    if not ready:return
                    profile=self.profiles.setdefault(g['key'],{})
                    self.profiles.move_to_end(g['key'])
                    while len(self.profiles)>1024:self.profiles.popitem(last=False)
                    rows=[{'ticket':t,'index':i,'id':f'I{t.order}_P{i}','text':t.units[i]} for t in ready for i in range(t.offset,len(t.units))]
                try:picked,estimate,reason=ready[0].context.copy().run(self.choose,rows,ready[0].ai,ready[0].target,profile)
                except Exception as exc:
                    self.finish(ready[0],exc)
                    continue
                owners=list(dict.fromkeys(row['ticket'] for row in picked))
                with self.lock:
                    if any(t.finished for t in owners):continue
                    for t in owners:self._waiting(t,'');t.in_flight=True
                    self._refresh_waits(g)
                try:
                    started=time.monotonic()
                    result=owners[0].context.copy().run(self.dispatch,picked,estimate,reason,profile)
                    turn_ms=max(0.0,(time.monotonic()-started)*1000)
                    values=result['values'];meta=result['meta'];receipt=meta.get('usage')
                    conversation=dict(meta.get('conversation') or {})
                    committed = conversation.get('historyTurns',0) > 0 or conversation.get('commitStatus') in ('pending_commit','committed','ephemeral_not_retained')
                    if committed:
                        profile['lastCommittedUnits']=len(picked)
                        profile['lastTurnMs']=turn_ms
                    with self.lock:
                        for t in owners:
                            t.in_flight=False
                            own=[(i,r) for i,r in enumerate(picked) if r['ticket'] is t]
                            t.offset+=len(own);t.meta=meta
                            t.refs.append({'operationId':result['batchId'],'requestUnits':len(picked),'pageUnits':len(own)})
                            if receipt:t.receipts.append(receipt)
                            if t.finished:continue
                            for i,r in own:t.values[r['index']]=values[i]
                            if t.offset==len(t.units):self.finish(t)
                except Exception as exc:
                    for t in owners:t.in_flight=False;self.finish(t,exc)
        finally:
            with self.lock:g['running']=False;self._start(g)
