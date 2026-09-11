#!/usr/bin/env python3
"""Deterministic microbenchmark for completion detection (no network)."""

from __future__ import annotations

import json
import os
import statistics
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "api"))

from backend.ai.clients.base import LineCompletionDetector
from backend.ai.transports.openai_chat import _JsonClosureGate, _JsonObjectCompletionDetector

RUNS = 40  # >= 30 warm measured runs
SIZES = (100, 500, 2000, 8000)
CHUNK = 7


def chunks(source):
    return [source[index:index + CHUNK] for index in range(0, len(source), CHUNK)]


def old_marker(parts):
    accumulated = []
    detector = LineCompletionDetector(["P0", "P1"])
    for part in parts:
        accumulated.append(part)
        detector.inspect("".join(accumulated), 1.0)


def new_marker(parts):
    accumulated, tail = [], ""
    detector = LineCompletionDetector(["P0", "P1"])
    for part in parts:
        accumulated.append(part)
        boundary = tail + part
        if ">>" in boundary:
            detector.inspect("".join(accumulated), 1.0)
        tail = boundary[-1:]


def old_json(parts):
    accumulated = []
    detector = _JsonObjectCompletionDetector(["P0", "P1"])
    for part in parts:
        accumulated.append(part)
        detector.inspect("".join(accumulated), 1.0)


def new_json(parts):
    accumulated = []
    gate = _JsonClosureGate()
    detector = _JsonObjectCompletionDetector(["P0", "P1"])
    for part in parts:
        accumulated.append(part)
        if gate.feed(part):
            detector.inspect("".join(accumulated), 1.0)


def percentile(values, fraction):
    return sorted(values)[min(len(values) - 1, int(len(values) * fraction))]


def measure(fn, parts):
    fn(parts)  # warmup excluded
    samples = []
    for _ in range(RUNS):
        started = time.perf_counter_ns()
        fn(parts)
        samples.append((time.perf_counter_ns() - started) / 1_000_000)
    return statistics.median(samples), percentile(samples, .90)


def main():
    print("# CPU completion-detector microbenchmark; synthetic 7-character chunks; "
          "no network/provider latency or request-count claim")
    print("protocol,size_chars,old_cpu_median_ms,new_cpu_median_ms,"
          "old_cpu_p90_ms,new_cpu_p90_ms,cpu_median_ratio")
    for protocol, old, new in (("marker", old_marker, new_marker), ("json", old_json, new_json)):
        for size in SIZES:
            padding = "x" * size
            source = (f"<<TP_P0:{padding}>>\n<<TP_P1:two>>" if protocol == "marker"
                      else json.dumps({"P0": padding, "P1": "two"}, separators=(",", ":")))
            parts = chunks(source)
            old_median, old_p90 = measure(old, parts)
            new_median, new_p90 = measure(new, parts)
            speedup = old_median / new_median if new_median else float("inf")
            print(f"{protocol},{size},{old_median:.4f},{new_median:.4f},"
                  f"{old_p90:.4f},{new_p90:.4f},{speedup:.2f}x")


if __name__ == "__main__":
    main()
