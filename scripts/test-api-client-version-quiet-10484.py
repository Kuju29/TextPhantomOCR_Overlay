""".84 owner rule: the API never prints a console line per extension version.

.82 printed "extension X is talking to API Y ..." once per differing version; on a
shared Hugging Face API every user's older extension would add a line. Offline."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
from backend.api import middleware

source = Path(middleware.__file__).read_text(encoding="utf-8")
assert "is talking to API" not in source and not hasattr(middleware, "note_client_version"), "version line removed"
print('{"passed": 1, "scope": "no per-extension-version console line"}')
