"""Progress-aware limits for one provider stream.

A single wall clock cannot tell a thinking model from a writing or stuck one,
so this module classifies every frame the transport already parses and
applies one limit per phase:

  waiting   response open, no reasoning/content yet (keep-alive comments,
            Anthropic pings and empty deltas only). Reported as "waiting at
            provider"; they never count as progress.
  thinking  reasoning deltas (OpenRouter ``reasoning``/``reasoning_details``,
            ``reasoning_content``, Anthropic thinking blocks, Gemini thought
            parts). Allowed while they arrive, for at most a time derived from
            the request's own reasoning token budget.
  writing   visible content. Allowed while it arrives *and* translated lines
            keep closing (LineCompletionDetector records).
  stalled   no reasoning/content frame within the idle window.

A real hang therefore ends at the idle window (30 s).

The guard never parses or stores model text beyond the line count it is
given, and reporting is best-effort: a slow or closed progress sink can never
change generation, accounting or completion.
"""
from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Callable, Iterable

# --- limits (seconds unless noted) ------------------------------------------
# No reasoning or content frame for this long after the model has started
# producing = stalled. Same value as the transport's socket read timeout, so a
# silent socket and a socket that only carries keep-alives end together.
STALL_IDLE_SEC = 30.0
# Response open but nothing but keep-alives yet (provider queue/routing, or a
# model that reasons without streaming it). OpenRouter's interactive endpoints
# are routed for a p90 start below 8 s; 60 s is far outside normal and still
# below the old 120 s budget, so a hung provider ends sooner than before.
FIRST_PROGRESS_SEC = 60.0
# Hidden-reasoning speed assumed when converting a token budget into time.
# Deliberately pessimistic: the slowest reasoning streams in our logs (GPT-5
# Pro via OpenRouter, 566 reasoning frames in 120 s) are well above it, so a
# model that is genuinely working inside its budget is never cut.
MIN_REASONING_TOKENS_PER_SEC = 15.0
# Bounds for the derived thinking time. The floor covers small budgets where
# connection setup and the first reasoning summary dominate; the ceiling keeps
# "the provider ignored our budget" from becoming an open-ended wait.
THINKING_FLOOR_SEC = 90.0
THINKING_CEILING_SEC = 300.0
# Writing phase: content keeps arriving but no further translated line closes
# for this long = the model is looping or rambling outside the record format.
# A single translated line is a few hundred tokens at most (seconds of output).
LINE_PROGRESS_SEC = 60.0
# Absolute safety ceiling for one provider request. It only triggers for a
# stream that satisfies every rule above (steady lines) yet never ends, and
# protects the admission slot and worker thread. Sized from the largest
# completion we request (8192 tokens) at a slow-but-healthy 15 tok/s (~550 s)
# plus a full thinking ceiling (300 s).
ABSOLUTE_CEILING_SEC = 900.0
# Progress events to the extension: phase changes are sent immediately, other
# updates at most this often (≤ 2 per second).
REPORT_INTERVAL_SEC = 0.5

WAITING, THINKING, WRITING, STALLED, STOPPING = "waiting", "thinking", "writing", "stalled", "stopping"

STOP_STALLED = "ai_provider_stalled"
STOP_THINKING_TOO_LONG = "ai_thinking_too_long"
STOP_NO_LINE_PROGRESS = "ai_output_no_progress"
STOP_CEILING = "ai_stream_ceiling"
STOP_CODES = (STOP_STALLED, STOP_THINKING_TOO_LONG, STOP_NO_LINE_PROGRESS, STOP_CEILING)


class StreamStopped(TimeoutError):
    """A provider stream ended by a progress rule (a TimeoutError subtype so
    existing timeout routing/outcome handling keeps working)."""

    def __init__(self, code: str, message: str, *, phase: str, elapsed_sec: float,
                 lines_done: int | None, lines_total: int | None, limit_sec: float) -> None:
        super().__init__(message)
        self.stream_stop_code = code
        self.code = code
        self.stream_stop = {
            "code": code, "phase": phase, "elapsedMs": round(elapsed_sec * 1000),
            "limitMs": round(limit_sec * 1000), "linesDone": lines_done, "linesTotal": lines_total,
        }


def thinking_limit_sec(reasoning_budget_tokens: int | None) -> float:
    """Time a model may think before its first content, from its token budget."""
    if type(reasoning_budget_tokens) is not int or reasoning_budget_tokens <= 0:
        return THINKING_CEILING_SEC
    return max(THINKING_FLOOR_SEC,
               min(THINKING_CEILING_SEC, reasoning_budget_tokens / MIN_REASONING_TOKENS_PER_SEC))


def _positive_int(value: Any) -> int | None:
    return value if type(value) is int and value > 0 else None


def reasoning_budget_from_payload(payload: dict[str, Any] | None) -> int | None:
    """The token bound on hidden reasoning that this exact request carries.

    An explicit reasoning budget wins (OpenRouter ``reasoning.max_tokens``,
    Anthropic ``thinking.budget_tokens``, Gemini ``thinkingBudget`` > 0).
    Otherwise reasoning shares the completion ceiling, which then bounds it.
    """
    data = payload if isinstance(payload, dict) else {}
    reasoning = data.get("reasoning") if isinstance(data.get("reasoning"), dict) else {}
    thinking = data.get("thinking") if isinstance(data.get("thinking"), dict) else {}
    config = data.get("generationConfig") if isinstance(data.get("generationConfig"), dict) else {}
    thinking_config = config.get("thinkingConfig") if isinstance(config.get("thinkingConfig"), dict) else {}
    explicit = (_positive_int(reasoning.get("max_tokens")) or _positive_int(thinking.get("budget_tokens"))
                or _positive_int(thinking_config.get("thinkingBudget")))
    ceiling = (_positive_int(data.get("max_completion_tokens")) or _positive_int(data.get("max_tokens"))
               or _positive_int(config.get("maxOutputTokens")))
    if explicit and ceiling:
        return min(explicit, ceiling)
    return explicit or ceiling


class StreamProgress:
    """Thread-safe phase tracker shared by a reader loop and its watcher.

    ``enforce=False`` only reports (Paid: the Center owns the provider call and
    its settlement, so the API must not abort it on its own clock).
    """

    def __init__(self, *, started: float | None = None, clock: Callable[[], float] = time.perf_counter,
                 reasoning_budget_tokens: int | None = None, lines_total: int | None = None,
                 report: Callable[[dict], None] | None = None, enforce: bool = True,
                 budget_sec: float | None = None, model: str = "") -> None:
        self.clock = clock
        self.started = clock() if started is None else started
        self.lock = threading.RLock()
        self.report_sink = report
        self.enforce = enforce
        self.model = model
        # A caller-supplied total budget shorter than a phase window (probes,
        # tests) tightens that window; it never extends one.
        cap = float(budget_sec) if isinstance(budget_sec, (int, float)) and budget_sec > 0 else None
        self.idle_sec = min(STALL_IDLE_SEC, cap) if cap else STALL_IDLE_SEC
        self.first_progress_sec = min(FIRST_PROGRESS_SEC, cap) if cap else FIRST_PROGRESS_SEC
        self.thinking_sec = thinking_limit_sec(reasoning_budget_tokens)
        self.line_sec = LINE_PROGRESS_SEC
        self.ceiling_sec = max(ABSOLUTE_CEILING_SEC, cap or 0.0)
        self.lines_total = lines_total if type(lines_total) is int and lines_total > 0 else None
        self.phase = WAITING
        self.phase_at = self.started
        self.opened_at: float | None = None
        self.progress_at: float | None = None
        self.thinking_at: float | None = None
        self.writing_at: float | None = None
        self.line_at: float | None = None
        self.lines_done = 0
        self.keepalives = 0
        self.reported_at: float | None = None
        self.reported_phase = ""
        self.stopped: StreamStopped | None = None

    # ---- observations (reader thread) --------------------------------------
    def opened(self) -> None:
        """Response headers accepted: the provider is now responsible."""
        with self.lock:
            now = self.clock()
            if self.opened_at is None:
                self.opened_at = now
        self._report(force=True)

    def keepalive(self) -> None:
        with self.lock:
            self.keepalives += 1
        self._report()

    def thinking(self) -> None:
        with self.lock:
            now = self.clock()
            self.progress_at = now
            if self.thinking_at is None:
                self.thinking_at = now
            if self.phase == WAITING:
                self._enter(THINKING, now)
        self._report()

    def writing(self, lines_done: int | None = None) -> None:
        with self.lock:
            now = self.clock()
            self.progress_at = now
            if self.writing_at is None:
                self.writing_at = now
                self.line_at = now
            if self.phase in (WAITING, THINKING):
                self._enter(WRITING, now)
            if type(lines_done) is int and lines_done > self.lines_done:
                self.lines_done = lines_done
                self.line_at = now
        self._report()

    def _enter(self, phase: str, now: float) -> None:
        self.phase = phase
        self.phase_at = now

    # ---- limits (watcher thread) -------------------------------------------
    def check(self) -> StreamStopped | None:
        """Return the stop that applies now (and remember it), else None."""
        if not self.enforce:
            return None
        with self.lock:
            if self.stopped is not None:
                return self.stopped
            now = self.clock()
            stop = self._rule(now)
            if stop is None:
                return None
            self.stopped = stop
            self.phase = STALLED if stop.stream_stop_code == STOP_STALLED else STOPPING
            self.phase_at = now
        self._report(force=True, reason=stop.stream_stop_code)
        return stop

    def _rule(self, now: float) -> StreamStopped | None:
        total = now - self.started
        name = self.model or "model"
        if total >= self.ceiling_sec:
            return self._stop(STOP_CEILING, f"AI stream exceeded the {self.ceiling_sec:g}s safety ceiling (model={name}, attempts=1)",
                              now, self.ceiling_sec)
        if self.progress_at is None:
            if total >= self.first_progress_sec:
                return self._stop(STOP_STALLED, f"AI provider total timeout after {self.first_progress_sec:g}s with no reasoning or text (model={name}, attempts=1)",
                                  now, self.first_progress_sec)
            return None
        if now - self.progress_at >= self.idle_sec:
            return self._stop(STOP_STALLED, f"AI provider stalled: no reasoning or text for {self.idle_sec:g}s (model={name}, attempts=1)",
                              now, self.idle_sec)
        if self.phase == THINKING and self.thinking_at is not None and now - self.thinking_at >= self.thinking_sec:
            return self._stop(STOP_THINKING_TOO_LONG, f"AI thought for {self.thinking_sec:g}s without starting the answer (model={name}, attempts=1)",
                              now, self.thinking_sec)
        # Line progress is judged once a total is known or one line has
        # closed, so non-record generations (summaries) are never cut by it.
        tracking = self.lines_total is not None or self.lines_done > 0
        if self.phase == WRITING and tracking and self.line_at is not None and now - self.line_at >= self.line_sec:
            return self._stop(STOP_NO_LINE_PROGRESS, f"AI kept writing for {self.line_sec:g}s without completing another line (model={name}, attempts=1)",
                              now, self.line_sec)
        return None

    def _stop(self, code: str, message: str, now: float, limit: float) -> StreamStopped:
        return StreamStopped(code, message, phase=self.phase, elapsed_sec=now - self.started,
                             lines_done=self.lines_done if self.writing_at is not None else None,
                             lines_total=self.lines_total, limit_sec=limit)

    # ---- reporting ----------------------------------------------------------
    def snapshot(self, reason: str = "") -> dict[str, Any]:
        with self.lock:
            now = self.clock()
            event = {"phase": self.phase,
                     "phaseElapsedMs": round(max(0.0, now - self.phase_at) * 1000),
                     "elapsedMs": round(max(0.0, now - self.started) * 1000),
                     "linesDone": self.lines_done if self.writing_at is not None else None,
                     "linesTotal": self.lines_total,
                     "keepalive": self.keepalives > 0 and self.progress_at is None}
            if self.phase == THINKING:
                event["thinkingLimitMs"] = round(self.thinking_sec * 1000)
            if reason:
                event["reason"] = reason
            return event

    def _report(self, *, force: bool = False, reason: str = "") -> None:
        sink = self.report_sink
        if sink is None:
            return
        with self.lock:
            now = self.clock()
            changed = self.phase != self.reported_phase
            if not (force or changed or self.reported_at is None
                    or now - self.reported_at >= REPORT_INTERVAL_SEC):
                return
            self.reported_at = now
            self.reported_phase = self.phase
        try:
            sink(self.snapshot(reason))
        except Exception:
            pass  # Progress display can never affect generation.


def report_sink() -> Callable[[dict], None] | None:
    """The request-local progress sink, captured on the request thread (watcher
    threads do not inherit context variables)."""
    from backend.ai import content_stream
    return content_stream.progress_sink()


# Native providers (Anthropic, Gemini) build their wire call from positional
# prompt arguments, not from the GenerationRequest; their adapters publish the
# request's translated-line IDs here so the stream can report "n/N lines" and
# apply the line-progress rule from the first record on.
_line_ids: ContextVar[tuple[str, ...]] = ContextVar("ai_stream_line_ids", default=())


@contextmanager
def expected_lines(ids: Iterable[str] | None):
    token = _line_ids.set(tuple(str(value) for value in (ids or ())))
    try:
        yield
    finally:
        _line_ids.reset(token)


def current_line_ids() -> list[str]:
    return list(_line_ids.get())


__all__ = [
    "ABSOLUTE_CEILING_SEC", "FIRST_PROGRESS_SEC", "LINE_PROGRESS_SEC", "MIN_REASONING_TOKENS_PER_SEC",
    "REPORT_INTERVAL_SEC", "STALL_IDLE_SEC", "THINKING_CEILING_SEC", "THINKING_FLOOR_SEC",
    "STOP_CODES", "STOP_CEILING", "STOP_NO_LINE_PROGRESS", "STOP_STALLED", "STOP_THINKING_TOO_LONG",
    "StreamProgress", "StreamStopped", "current_line_ids", "expected_lines", "reasoning_budget_from_payload",
    "report_sink", "thinking_limit_sec",
]
