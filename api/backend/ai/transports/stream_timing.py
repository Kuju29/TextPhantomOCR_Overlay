"""Bounded, content-free timing at the existing transport reader boundary.

Read waits are observed at iterator yield, not attributed to the network or
provider. Callback/processing/write intervals distinguish local backpressure.
"""
from contextlib import contextmanager
import time


class StreamTiming:
    def __init__(self, started=None, *, clock=time.perf_counter):
        self.clock = clock
        self.started = clock() if started is None else started
        self.received_at = None
        self.processed_at = None
        self.first_content = self.last_content = None
        self.terminal_at = self.ended_at = None
        self.terminal_kind = "none"
        self.frames = self.contents = 0
        self.max_frame_gap = self.max_content_gap = self.max_read_wait = 0.0
        self.totals = {"frameProcessing": 0.0, "deltaCallback": 0.0, "wireWrite": 0.0}
        self.maxima = dict(self.totals)

    @contextmanager
    def measure(self, field):
        before = self.clock()
        try:
            yield
        finally:
            dt = max(0.0, self.clock() - before)
            self.totals[field] += dt
            self.maxima[field] = max(self.maxima[field], dt)

    @contextmanager
    def frame(self):
        now = self.clock()
        if self.received_at is not None:
            self.max_frame_gap = max(self.max_frame_gap, now - self.received_at)
        if self.processed_at is not None:
            self.max_read_wait = max(self.max_read_wait, now - self.processed_at)
        self.received_at = now
        self.frames += 1
        try:
            with self.measure("frameProcessing"):
                yield
        finally:
            self.processed_at = self.clock()

    def content(self):
        now = self.received_at if self.received_at is not None else self.clock()
        if self.first_content is None:
            self.first_content = now
        if self.last_content is not None:
            self.max_content_gap = max(self.max_content_gap, now - self.last_content)
        self.last_content = now
        self.contents += 1

    def terminal(self, kind):
        self.terminal_at = self.clock()
        self.terminal_kind = kind

    def finish(self):
        self.ended_at = self.clock()

    def snapshot(self):
        ms = lambda value: None if value is None else round(max(0.0, value) * 1000, 2)
        elapsed = lambda value: None if value is None else ms(value - self.started)
        result = {"schema": "tp.stream-timing/1", "boundary": "transport_reader",
            "framesObserved": self.frames, "contentChunks": self.contents,
            "firstContentMs": elapsed(self.first_content), "lastContentMs": elapsed(self.last_content),
            "lastFrameMs": elapsed(self.received_at), "protocolTerminalMs": elapsed(self.terminal_at),
            "streamEndedMs": elapsed(self.ended_at), "terminalKind": self.terminal_kind,
            "maxInterFrameGapMs": ms(self.max_frame_gap), "maxInterContentGapMs": ms(self.max_content_gap),
            "maxReadWaitMs": ms(self.max_read_wait),
            "tailAfterContentMs": ms(self.ended_at - self.last_content)
                if self.ended_at is not None and self.last_content is not None else None}
        for key in self.totals:
            result[key + "Ms"] = ms(self.totals[key])
            result["max" + key[0].upper() + key[1:] + "Ms"] = ms(self.maxima[key])
        return result

    def audit(self):
        from backend.ai.accounting import diagnostic_identity
        return {"schema": "tp.audit/1", "event": "stream_timing", "reason": "stream_observed",
                **diagnostic_identity(), "timing": self.snapshot()}
