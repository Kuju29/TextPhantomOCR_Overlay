"""Request-local visible content delivery; never changes provider completion."""
from contextlib import contextmanager
from asyncio import Event
from contextvars import ContextVar
from typing import Callable

_callback: ContextVar[Callable[[str], None] | None] = ContextVar("ai_content_callback", default=None)

_cancel_event: ContextVar[Event | None] = ContextVar("ai_content_cancel", default=None)

def cancellation_event() -> Event | None:
    return _cancel_event.get()

def active() -> bool:
    return _callback.get() is not None


def emit(text: str) -> None:
    callback = _callback.get()
    if callback is not None and isinstance(text, str) and text:
        callback(text)


@contextmanager
def scope(callback: Callable[[str], None], cancel_event: Event | None = None):
    token = _callback.set(callback)
    cancel_token = _cancel_event.set(cancel_event)
    try:
        yield
    finally:
        _callback.reset(token)
        _cancel_event.reset(cancel_token)
