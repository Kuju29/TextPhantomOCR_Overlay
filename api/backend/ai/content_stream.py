"""Request-local visible content delivery; never changes provider completion."""
from contextlib import contextmanager
from asyncio import Event
from contextvars import ContextVar
from typing import Callable

_callback: ContextVar[Callable[[str], None] | None] = ContextVar("ai_content_callback", default=None)

_cancel_event: ContextVar[Event | None] = ContextVar("ai_content_cancel", default=None)

# Stream phase events (waiting/thinking/writing/stalled). Separate from
# the content callback: progress is never "generated text", so watch() and the
# no-retry-after-content rule are unaffected, and only a caller that asked for
# phase events receives them.
_progress: ContextVar[Callable[[dict], None] | None] = ContextVar("ai_stream_progress", default=None)

def cancellation_event() -> Event | None:
    return _cancel_event.get()

def active() -> bool:
    return _callback.get() is not None


def emit(text: str) -> None:
    callback = _callback.get()
    if callback is not None and isinstance(text, str) and text:
        callback(text)


def progress_sink() -> Callable[[dict], None] | None:
    return _progress.get()


def report(event: dict) -> None:
    """Best-effort phase event; never raises into generation."""
    sink = _progress.get()
    if sink is not None and isinstance(event, dict):
        try:
            sink(event)
        except Exception:
            pass


@contextmanager
def scope(callback: Callable[[str], None], cancel_event: Event | None = None,
          progress: Callable[[dict], None] | None = None):
    token = _callback.set(callback)
    cancel_token = _cancel_event.set(cancel_event)
    progress_token = _progress.set(progress)
    try:
        yield
    finally:
        _callback.reset(token)
        _cancel_event.reset(cancel_token)
        _progress.reset(progress_token)


@contextmanager
def watch():
    """Observe whether any visible text was delivered inside this block
    (a provider retry is only allowed when nothing was generated)."""
    state = {"emitted": False}
    current = _callback.get()
    if current is None:
        yield state
        return

    def forward(text: str) -> None:
        state["emitted"] = True
        current(text)

    token = _callback.set(forward)
    try:
        yield state
    finally:
        _callback.reset(token)
