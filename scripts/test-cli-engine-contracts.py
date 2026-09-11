"""Regression checks for CLI Cloud-AI parity across both engine owners."""

from __future__ import annotations

import ast
import contextlib
import io
from pathlib import Path
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend import cli  # noqa: E402
from backend.ai.translation.contracts import AiConfig  # noqa: E402

for value in (None, "", "auto", "garbage", False, 7, "off"):
    assert AiConfig(api_key="", thinking=value).thinking == "off"
assert AiConfig(api_key="", thinking="on").thinking == "on"


with tempfile.TemporaryDirectory(prefix="tp-cli-contract-") as temp_dir:
    image = Path(temp_dir) / "input.jpg"
    image.write_bytes(b"contract-validation-does-not-decode-image")
    for engine in ("api", "extension"):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            status = cli.main([str(image), "--engine", engine, "--source", "ai"])
        assert status == 2, (engine, status, stderr.getvalue())
        assert "requires --ai-prompt" in stderr.getvalue(), (engine, stderr.getvalue())
        assert "no prompt fallback" in stderr.getvalue(), (engine, stderr.getvalue())

tree = ast.parse(
    (ROOT / "api" / "backend" / "cli.py").read_text(encoding="utf-8"),
    filename="api/backend/cli.py",
)
constructors = [
    node for node in ast.walk(tree)
    if isinstance(node, ast.Call)
    and isinstance(node.func, ast.Name)
    and node.func.id == "AiConfig"
]
assert len(constructors) == 1, "CLI must have one auditable AiConfig construction"
keywords = {item.arg: item.value for item in constructors[0].keywords if item.arg}
thinking = keywords.get("thinking")
assert (
    isinstance(thinking, ast.Attribute)
    and isinstance(thinking.value, ast.Name)
    and thinking.value.id == "args"
    and thinking.attr == "ai_thinking"
), "--ai-thinking must be forwarded into AiConfig instead of being silently ignored"

# Parser normalization is exercised before image decoding: historical Auto and
# malformed CLI values become Off rather than provider-managed behavior.
for value in ("auto", "garbage"):
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        status = cli.main(["missing.jpg", "--source", "ai", "--ai-thinking", value])
    assert status == 2
    assert "invalid choice" not in stderr.getvalue()

cli_source = (ROOT / "api" / "backend" / "cli.py").read_text(encoding="utf-8")
driver_source = (ROOT / "scripts" / "cli-extension-driver.mjs").read_text(encoding="utf-8")
for engine, source in (("runsapi", cli_source), ("runsextension", driver_source)):
    assert "tp.cli-run-status/1" in source, f"{engine} must emit an explicit CLI run-status contract"
    assert "not_tested_source_not_ai" in source, (
        f"{engine} must not claim AI end-to-end coverage for translated/original structural runs"
    )
    assert "not_tested_requires_browser" in source, (
        f"{engine} must state that CLI does not prove browser insertion"
    )

with tempfile.TemporaryDirectory(prefix="tp-cli-clean-") as temp_dir:
    output = Path(temp_dir)
    (output / "error.json").write_text('{"stale":true}', encoding="utf-8")
    cli._dump({}, {}, output, source="translated")
    assert not (output / "error.json").exists(), "successful API CLI rerun must remove stale error.json"
    status = __import__("json").loads((output / "run_status.json").read_text(encoding="utf-8"))
    assert status["structuralOk"] is True
    assert status["aiEndToEnd"] == "not_tested_source_not_ai"

print("CLI engine contracts passed: prompt fails closed, thinking is forwarded, and structural runs do not claim AI E2E.")
