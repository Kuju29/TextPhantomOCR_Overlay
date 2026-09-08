"""Keep Python data contracts imported from their owning module.

Importing ``AiConfig`` through the provider invocation implementation used to
make CLI/type-checking depend on an incidental re-export.  That breaks as soon
as invocation.py stops importing that name or provider dependencies are not
installed yet.
"""

from __future__ import annotations

import ast
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
API_ROOT = ROOT / "api"
BACKEND = API_ROOT / "backend"

sys.path.insert(0, str(API_ROOT))
from backend.ai.translation.contracts import AiConfig  # noqa: E402


config = AiConfig(api_key="test")
assert config.api_key == "test"

violations: list[str] = []
for path in BACKEND.rglob("*.py"):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom):
            continue
        if node.module != "backend.ai.translation.invocation":
            continue
        if any(alias.name in {"AiConfig", "AiResult"} for alias in node.names):
            violations.append(f"{path.relative_to(ROOT)}:{node.lineno}")

assert not violations, (
    "translation contracts must be imported from "
    f"backend.ai.translation.contracts, not invocation.py: {violations}"
)

cli_tree = ast.parse(
    (BACKEND / "cli.py").read_text(encoding="utf-8"),
    filename="api/backend/cli.py",
)
assert any(
    isinstance(node, ast.ImportFrom)
    and node.module == "backend.ai.translation.contracts"
    and any(alias.name == "AiConfig" for alias in node.names)
    for node in cli_tree.body
), "cli.py must import AiConfig from its defining module"

print("Python import contracts passed: AiConfig has one stable owner.")
