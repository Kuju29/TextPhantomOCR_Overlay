"""Synthetic disk-pressure and cross-process diagnostic retention checks."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))
from backend import diagnostic_retention as retention
from backend.ai import wire_trace


def aged(folder: Path) -> None:
    old = time.time() - 9 * 86400
    for item in folder.iterdir():
        os.utime(item, (old, old), follow_symlinks=False)
    os.utime(folder, (old, old))


def child_env(**values) -> dict:
    result = {key: value for key, value in os.environ.items()
              if not key.startswith(("TP_TRACE", "TP_AI_WIRE_TRACE", "TP_DIAGNOSTICS"))}
    result.update(PYTHONPATH=str(ROOT / "api"), **values)
    return result


class WireRetention(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tp-retention-wire-")
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {
            "TP_AI_WIRE_TRACE": "1", "TP_AI_WIRE_TRACE_DIR": str(self.root),
            "TP_AI_WIRE_TRACE_MAX_BYTES": str(128 * 1024),
            "TP_AI_WIRE_TRACE_OPERATION_MAX_BYTES": str(96 * 1024),
            "TP_AI_WIRE_TRACE_KEEP_DAYS": "7",
        })
        self.env.start()

    def tearDown(self):
        for folder in list(wire_trace._relay_folders):
            wire_trace.finish_in(folder)
        for folder in list(wire_trace._folder_leases):
            while folder in wire_trace._folder_leases:
                wire_trace._release_folder(folder)
        self.env.stop()
        self.temp.cleanup()

    def operation(self, name):
        token = wire_trace.begin({"traceId": name, "operationId": name})
        return token, wire_trace.active_folder()

    def prune(self, budget=None):
        with wire_trace._lock, retention.guard(self.root, "wire"):
            return wire_trace._prune_locked(self.root, budget=budget)

    def test_defaults_and_invalid_overrides_remain_bounded(self):
        with patch.dict(os.environ, {"TP_AI_WIRE_TRACE_MAX_BYTES": "0",
                                    "TP_AI_WIRE_TRACE_KEEP_DAYS": "bad",
                                    "TP_AI_WIRE_TRACE_OPERATION_MAX_BYTES": "-1"}):
            self.assertEqual(wire_trace.retention_limits(), {
                "maxBytes": 256 * 1024 * 1024, "keepDays": 7,
                "operationMaxBytes": 16 * 1024 * 1024,
                "maxOperations": 2048, "maxActiveOperations": 256, "maxFiles": 32768,
            })

    def test_old_completed_pruned_but_live_terminal_and_orphan_kept(self):
        old = self.root / "img-unknown--initial--old--old"
        old.mkdir()
        (old / "11_terminal.json").write_text('{"terminal":true}')
        (old / "content.txt").write_text("synthetic")
        aged(old)
        orphan = self.root / "img-unknown--initial--orphan--orphan"
        orphan.mkdir()
        (orphan / "11_terminal.json").write_text('{"terminal":false}')
        aged(orphan)
        token, live = self.operation("live")
        wire_trace.terminal(state="failed")
        aged(live)
        self.prune()
        self.assertFalse(old.exists())
        self.assertTrue(orphan.exists())
        self.assertTrue(live.exists(), "terminal is not equivalent to ended")
        # Late timing must remain writable after a failure terminal.
        wire_trace.write_json("09_timing.json", {"providerMs": 5})
        aged(live)
        wire_trace.end(token)
        self.assertFalse(live.exists())

    def test_byte_pressure_prunes_oldest_completed_and_never_active(self):
        token_a, folder_a = self.operation("a")
        wire_trace.write_text("02_system_prompt.txt", "a" * (50 * 1024))
        wire_trace.terminal(state="succeeded")
        # A stays leased even after its terminal row.
        token_b, folder_b = self.operation("b")
        wire_trace.write_text("02_system_prompt.txt", "b" * (70 * 1024))
        self.assertIsNone(wire_trace.active_folder())
        self.assertTrue(folder_a.exists())
        self.assertEqual((folder_b / "04_provider_request.json").read_text(), '{\n  "status": "not_reached"\n}\n')
        wire_trace.terminal(state="failed")
        wire_trace.end(token_b)
        wire_trace.end(token_a)
        token_c, folder_c = self.operation("c")
        wire_trace.write_text("02_system_prompt.txt", "c" * (70 * 1024))
        self.assertFalse(folder_a.exists())
        self.assertTrue(folder_c.exists())
        self.assertLessEqual(wire_trace._scan_bytes(self.root), 128 * 1024)
        wire_trace.end(token_c)

    def test_operation_limit_fails_visibly_without_partial_content(self):
        token, folder = self.operation("bounded")
        before = wire_trace._scan_bytes(self.root)
        wire_trace.write_text("02_system_prompt.txt", "x" * (96 * 1024))
        self.assertIsNone(wire_trace.active_folder())
        self.assertLessEqual(wire_trace._scan_bytes(self.root), before)
        self.assertFalse((folder / "02_system_prompt.txt").exists())
        wire_trace.end(token)

    def test_abandoned_fresh_ids_cannot_grow_leases_or_folders_indefinitely(self):
        with patch.dict(os.environ, {"TP_AI_WIRE_TRACE_MAX_ACTIVE_OPERATIONS": "2",
                                    "TP_AI_WIRE_TRACE_MAX_OPERATIONS": "2"}):
            folders = []
            for index in range(2):
                folder = self.root / f"img-unknown--initial--relay{index}--relay{index}"
                wire_trace.begin_in(folder, {"traceId": f"relay{index}"})
                folders.append(folder)
            for index in range(2, 30):
                folder = self.root / f"img-unknown--initial--relay{index}--relay{index}"
                with self.assertRaises(wire_trace.AiWireTraceWriteError):
                    wire_trace.begin_in(folder, {"traceId": f"relay{index}"})
                self.assertFalse(folder.exists())
            self.assertEqual(len(wire_trace._folder_leases), 2)
            with retention.guard(self.root, "wire"):
                self.assertEqual(retention.active_count(self.root, "wire"), 2)
            for folder in folders:
                wire_trace.finish_in(folder)
            # Unfinished forensic captures remain, but the folder cap still
            # refuses new IDs after their live lease reservations were freed.
            with self.assertRaises(wire_trace.AiWireTraceWriteError):
                wire_trace.begin_in(self.root / "img-unknown--initial--new--new", {})
            self.assertEqual(sum(item.is_dir() for item in self.root.iterdir()), 2)

    def test_file_count_and_metadata_are_in_the_same_capacity_budget(self):
        with patch.dict(os.environ, {"TP_AI_WIRE_TRACE_MAX_FILES": "15"}):
            token, folder = self.operation("many-files")
            for index in range(30):
                try:
                    wire_trace.write_json(f"extra-{index}.json", {"synthetic": True})
                except wire_trace.AiWireTraceWriteError:
                    break
            total, files = wire_trace._scan_usage(self.root)
            self.assertLessEqual(files, 15)
            self.assertGreater(total, sum(item.stat().st_size for item in folder.iterdir()))
            self.assertLessEqual(total, 128 * 1024)
            wire_trace.end(token)

    def test_exact_utf8_byte_accounting_append_and_overwrite(self):
        token, _folder = self.operation("unicode")
        wire_trace.write_text("02_system_prompt.txt", "ทดลอง" * 50)
        wire_trace.append_assembled("คำแปล" * 20)
        wire_trace.append_assembled("追加")
        wire_trace.assembled_response("短")
        state = json.loads((self.root / "_wire-retention.json").read_text())
        self.assertEqual(state["bytes"], wire_trace._scan_bytes(self.root))
        wire_trace.end(token)

    def test_resume_lease_outlives_ingress_and_relay_failure_is_not_finish(self):
        token, folder = self.operation("nested")
        nested = wire_trace.resume(folder)
        wire_trace.terminal(state="succeeded")
        aged(folder)
        wire_trace.end(nested)
        self.assertTrue(folder.exists())
        wire_trace.end(token)
        self.assertFalse(folder.exists())
        relay = self.root / "img-unknown--initial--relay--relay"
        wire_trace.begin_in(relay, {"traceId": "relay"})
        wire_trace.write_json_in(relay, "11_terminal.json", {"terminal": True, "state": "failed"})
        aged(relay)
        self.prune()
        self.assertTrue(relay.exists())
        wire_trace.write_json_in(relay, "09_timing.json", {"providerMs": 7})
        aged(relay)
        wire_trace.finish_in(relay)
        self.assertFalse(relay.exists())

    def test_symlink_target_is_not_followed_or_deleted(self):
        with tempfile.TemporaryDirectory(prefix="tp-retention-outside-") as other:
            outside = Path(other) / "protected.txt"
            outside.write_text("synthetic unchanged")
            token, folder = self.operation("links")
            try:
                (folder / "02_system_prompt.txt").symlink_to(outside)
            except OSError:
                self.skipTest("symlinks unavailable")
            wire_trace.write_text("02_system_prompt.txt", "changed")
            self.assertIsNone(wire_trace.active_folder())
            wire_trace.terminal(state="succeeded")
            aged(folder)
            wire_trace.end(token)
            self.assertTrue(folder.exists())
            self.assertEqual(outside.read_text(), "synthetic unchanged")

    def test_another_process_live_folder_survives_retention(self):
        code = """
from pathlib import Path
from backend.ai import wire_trace
import os, sys, time
token=wire_trace.begin({'traceId':'worker','operationId':'worker'})
wire_trace.terminal(state='failed')
folder=wire_trace.active_folder()
old=time.time()-9*86400
for item in folder.iterdir(): os.utime(item,(old,old))
os.utime(folder,(old,old))
print(folder.name,flush=True)
sys.stdin.readline()
wire_trace.end(token)
"""
        process = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   env=child_env(TP_AI_WIRE_TRACE="1", TP_AI_WIRE_TRACE_DIR=str(self.root)))
        try:
            folder = self.root / process.stdout.readline().strip()
            self.assertTrue(folder.is_dir())
            self.prune()
            self.assertTrue(folder.is_dir(), "another worker's terminal folder is still active")
            process.stdin.write("finish\n")
            process.stdin.flush()
            output, error = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, error or output)
            self.prune()
            self.assertFalse(folder.exists())
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_global_active_reservation_and_crash_cleanup(self):
        code = """
from backend.ai import wire_trace
import sys
token=wire_trace.begin({'traceId':'crashed-worker','operationId':'crashed-worker'})
print(wire_trace.active_folder().name,flush=True)
sys.stdin.readline()
"""
        with patch.dict(os.environ, {"TP_AI_WIRE_TRACE_MAX_ACTIVE_OPERATIONS": "1"}):
            process = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                env=child_env(TP_AI_WIRE_TRACE="1", TP_AI_WIRE_TRACE_DIR=str(self.root),
                              TP_AI_WIRE_TRACE_MAX_ACTIVE_OPERATIONS="1"))
            try:
                orphan = self.root / process.stdout.readline().strip()
                self.assertTrue(orphan.is_dir())
                blocked = wire_trace.begin({"traceId": "blocked-other-worker", "operationId": "blocked-other-worker"})
                self.assertIsNone(wire_trace.active_folder())
                wire_trace.end(blocked)
                self.assertEqual(len(list(self.root.glob("_wire-active-*.lock"))), 1)
                process.kill()
                process.communicate(timeout=10)
                token, folder = self.operation("after-crash")
                self.assertTrue(folder.is_dir())
                self.assertTrue(orphan.is_dir(), "unfinished crash evidence must remain")
                with retention.guard(self.root, "wire"):
                    self.assertEqual(retention.active_count(self.root, "wire"), 1)
                wire_trace.end(token)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

    def test_two_workers_share_one_byte_budget(self):
        code = """
from backend.ai import wire_trace
import sys
name=sys.argv[1]
token=wire_trace.begin({'traceId':name,'operationId':name})
print('ready',flush=True)
sys.stdin.readline()
wire_trace.write_text('02_system_prompt.txt','synthetic-'*5120)
if wire_trace.active_folder() is None:
 print('capacity',flush=True)
else:
 wire_trace.terminal(state='succeeded')
 print('stored',flush=True)
sys.stdin.readline()
wire_trace.end(token)
"""
        env = child_env(TP_AI_WIRE_TRACE="1", TP_AI_WIRE_TRACE_DIR=str(self.root),
                        TP_AI_WIRE_TRACE_MAX_BYTES=str(160 * 1024))
        workers = [subprocess.Popen([sys.executable, "-c", code, f"quota-worker-{n}"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=env) for n in range(2)]
        try:
            for process in workers:
                self.assertEqual(process.stdout.readline().strip(), "ready")
            outcomes = []
            for process in workers:
                process.stdin.write("write\n")
                process.stdin.flush()
                outcomes.append(process.stdout.readline().strip())
            self.assertEqual(outcomes, ["stored", "capacity"])
            self.assertLessEqual(wire_trace._scan_bytes(self.root), 160 * 1024)
            for process in workers:
                process.stdin.write("finish\n")
                process.stdin.flush()
                out, err = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 0, err or out)
        finally:
            for process in workers:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

    def test_same_artifact_overwrite_accounting_reads_after_shared_lock(self):
        token, folder = self.operation("shared-artifact")
        wire_trace.write_text("02_system_prompt.txt", "synthetic" * 1024)
        code = """
from backend.ai import wire_trace
from contextlib import contextmanager
import sys
token=wire_trace.begin({'traceId':'shared-artifact','operationId':'shared-artifact'})
original=wire_trace.retention.guard
@contextmanager
def held(root,category):
 print('queued',flush=True)
 sys.stdin.readline()
 with original(root,category): yield
wire_trace.retention.guard=held
wire_trace.write_text('02_system_prompt.txt','x'*6000)
wire_trace.retention.guard=original
print('written',flush=True)
sys.stdin.readline()
wire_trace.end(token)
"""
        process = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env=child_env(TP_AI_WIRE_TRACE="1", TP_AI_WIRE_TRACE_DIR=str(self.root)))
        try:
            self.assertEqual(process.stdout.readline().strip(), "queued")
            wire_trace.write_text("02_system_prompt.txt", "short synthetic")
            process.stdin.write("resume\n")
            process.stdin.flush()
            self.assertEqual(process.stdout.readline().strip(), "written")
            self.assertEqual((folder / "02_system_prompt.txt").stat().st_size, 6000)
            state = json.loads((self.root / "_wire-retention.json").read_text())
            self.assertEqual(state["bytes"], wire_trace._scan_bytes(self.root))
            process.stdin.write("finish\n")
            process.stdin.flush()
            out, err = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, err or out)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
            wire_trace.end(token)


class CompactRetention(unittest.TestCase):
    def run_child(self, code, **values):
        result = subprocess.run([sys.executable, "-c", code],
                                env=child_env(**values), text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        return result.stdout

    def test_compact_rotation_age_size_identity_and_redaction(self):
        with tempfile.TemporaryDirectory(prefix="tp-retention-compact-") as temp:
            root = Path(temp)
            old = root / "trace-20000101.jsonl"
            old.write_text("old synthetic evidence\n")
            os.utime(old, (1, 1))
            self.run_child("""
from backend import trace
trace.start_session()
for n in range(120):
    trace.write('api','fixture.py','operation','..',{'index':n,'text':'PRIVATE-SYNTHETIC','authorization':'Bearer SYNTHETIC-SECRET'})
    trace.flush()
assert trace._KEEP_DAYS==7
""", TP_TRACE="1", TP_TRACE_DIR=temp, TP_TRACE_MAX_BYTES=str(52 * 1024), TP_TRACE_FILE_MAX_BYTES="1400")
            files = list(root.glob("trace-*.jsonl"))
            self.assertFalse(old.exists())
            self.assertTrue(any("-part" in item.name for item in files))
            charged = 7 * retention.ALLOCATION_UNIT + sum(retention.charge(item.stat().st_size) for item in files)
            self.assertLessEqual(charged, 52 * 1024)
            rows = []
            for item in files:
                self.assertLessEqual(item.stat().st_size, 1400)
                text = item.read_text()
                self.assertNotIn("PRIVATE-SYNTHETIC", text)
                self.assertNotIn("SYNTHETIC-SECRET", text)
                local = [json.loads(line) for line in text.splitlines()]
                self.assertEqual([row["seq"] for row in local], sorted(row["seq"] for row in local))
                rows.extend(local)
            self.assertEqual(len({row["session"] for row in rows}), 1)
            self.assertIn((root / "trace-latest.txt").read_text().strip(), {item.name for item in files})

    def test_custom_compact_names_share_one_category_budget(self):
        with tempfile.TemporaryDirectory(prefix="tp-retention-prefixes-") as temp:
            code = """
from backend import trace
for index in range(60):
 trace.write('api','fixture','event','..',{'index':index})
 trace.flush()
"""
            for name in ("trace-one", "trace-two", "trace-three"):
                self.run_child(code, TP_TRACE="1", TP_TRACE_DIR=temp, TP_TRACE_FILE=name,
                               TP_TRACE_MAX_BYTES=str(52 * 1024), TP_TRACE_FILE_MAX_BYTES="1400")
            root = Path(temp)
            files = list(root.glob("trace-*.jsonl"))
            charged = 7 * retention.ALLOCATION_UNIT + sum(retention.charge(item.stat().st_size) for item in files)
            self.assertLessEqual(charged, 52 * 1024)
            self.assertEqual(set(json.loads((root / "_trace-prefixes.json").read_text())),
                             {"trace-one", "trace-two", "trace-three"})

    def test_broken_compact_sink_never_fails_request_and_memory_is_bounded(self):
        with tempfile.TemporaryDirectory(prefix="tp-retention-broken-") as temp:
            blocker = Path(temp) / "blocked"
            blocker.write_text("synthetic")
            self.run_child("""
from backend import trace
trace.start_session()
for n in range(8400): trace.write('api','fixture','event','..',{'index':n})
trace.flush()
assert len(trace._buffer)<=trace._MAX_PENDING_LINES
assert trace._buffer_dropped>0
""", TP_TRACE="1", TP_TRACE_DIR=str(blocker))

    def test_other_worker_live_compact_file_survives_age_pruning(self):
        with tempfile.TemporaryDirectory(prefix="tp-retention-workers-") as temp:
            code = """
from backend import trace
import os,sys
trace.start_session()
trace.flush()
os.utime(trace.path(),(1,1))
print(trace.path().name,flush=True)
sys.stdin.readline()
"""
            process = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                       env=child_env(TP_TRACE="1", TP_TRACE_DIR=temp))
            try:
                target = Path(temp) / process.stdout.readline().strip()
                self.assertTrue(target.is_file())
                self.run_child("from backend import trace;trace.start_session();trace.flush()", TP_TRACE="1", TP_TRACE_DIR=temp)
                self.assertTrue(target.exists())
                process.stdin.write("finish\n")
                process.stdin.flush()
                out, err = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 0, err or out)
                self.run_child("from backend import trace;trace.start_session();trace.flush()", TP_TRACE="1", TP_TRACE_DIR=temp)
                self.assertFalse(target.exists())
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()


if __name__ == "__main__":
    unittest.main(verbosity=2)
