""".87 owner log: a repair of 1-4 lines after a 93-line Conversation turn moved to
another host and lost the prompt cache (cached 0 of ~6,000 input tokens). A small
repair now stays on the host; a whole-answer failure still avoids it. Also: the
Lens cookie source defaults to direct-first."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.ai.routing.observations import Observations  # noqa: E402
from backend.ai.routing.scoreboard import Scoreboard, StickyMap  # noqa: E402

checks = []
clock = [1000.0]
obs = Observations(Scoreboard(clock=lambda: 3600.0 * 900), StickyMap(), clock=lambda: clock[0],
                   settings=lambda: {"cooldown_failures": 3, "cooldown_window_min": 10, "cooldown_min": 30})

def fail(host, outcome, units):
    attempt = obs.record("openrouter", "m/x", host, "fp8", "unvalidated", avoid="k", units=units)
    assert obs.finalize([attempt], outcome) == 1

fail("deepinfra/fp8", "wrong_language", 93)
assert obs.avoid_hosts("openrouter", "m/x", "k", 2) == [], "a 2-line repair keeps the host (cache)"
assert obs.avoid_hosts("openrouter", "m/x", "k", 50) == ["deepinfra/fp8"], "half or more of the answer: avoid"
assert obs.avoid_hosts("openrouter", "m/x", "k") == ["deepinfra/fp8"], "unknown repair size: avoid (as .86)"
checks.append("wrong language on a few lines keeps the host; most of the page avoids it")

fail("together", "format", 93)
assert "together" in obs.avoid_hosts("openrouter", "m/x", "k", 1), "an unusable whole answer is always avoided"
checks.append("empty/format answers are always avoided")

obs2 = Observations(Scoreboard(clock=lambda: 3600.0 * 900), StickyMap(), clock=lambda: clock[0],
                    settings=lambda: {"cooldown_failures": 3, "cooldown_window_min": 10, "cooldown_min": 30})
attempt = obs2.record("openrouter", "m/x", "digitalocean", "bf16", "unvalidated", avoid="k")
obs2.finalize([attempt], "missing_ids")
assert obs2.avoid_hosts("openrouter", "m/x", "k", 1) == ["digitalocean"], "unknown attempt size: avoid (as .86)"
checks.append("attempts recorded without a line count keep the .86 rule")

from backend.ai.routing.openrouter import units_of  # noqa: E402
class R: expected_ids = ("a", "b", "c")
assert units_of(R()) == 3 and units_of(object()) == 0
checks.append("line count comes from the request's expected ids")

import os  # noqa: E402
os.environ.pop("TP_LENS_COOKIE_SOURCE", None)
from backend.config import Settings  # noqa: E402
assert Settings().lens_cookie_source == "direct-first"
from backend.lens import cookie  # noqa: E402
import dataclasses  # noqa: E402
from unittest.mock import patch  # noqa: E402
with patch.object(cookie, "settings", dataclasses.replace(cookie.settings, lens_cookie_source="")):
    assert cookie._order() == ("direct", "firebase")
with patch.object(cookie, "settings", dataclasses.replace(cookie.settings, lens_cookie_source="auto")):
    assert cookie._order() == ("firebase", "direct")
checks.append("Lens cookie: direct-first by default (Firebase as fallback); auto still selectable")

print(json.dumps({"passed": len(checks), "checks": checks}, ensure_ascii=False))
