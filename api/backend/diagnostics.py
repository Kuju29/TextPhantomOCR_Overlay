"""Operational diagnostics gated ONLY by TP_LOG_FILE; separate from TP_TRACE."""
from backend import logfile
from backend.diagnostic_core import *
from backend.diagnostic_core import EventWriter
from backend.release import RELEASE

writer = EventWriter(logfile.log_dir(), service='extension-api', release=RELEASE,
                     enabled=logfile.is_enabled())

def headers():
    ctx=current()
    return {'X-TP-Trace-ID':str(ctx.get('trace_id') or new_id()),
            'X-TP-Request-ID':str(ctx.get('request_id') or new_id()),
            'X-TP-Client-Version':valid_id(ctx.get('client_version')) or RELEASE}


def bind_context(fn):
    """Capture at dispatch, not import time; each executor invocation gets a copy."""
    import contextvars
    context=contextvars.copy_context()
    def run(*args,**kwargs):
        return context.copy().run(fn,*args,**kwargs)
    return run
