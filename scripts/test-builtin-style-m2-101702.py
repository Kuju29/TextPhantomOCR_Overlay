"""2026.10.17.2: M2 built-in styles; text already in a user's style box is never replaced."""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))
from backend.ai.prompts.styles import PROMPT_POLICY_VERSION, lang_style, select_style
from backend.ai.prompts.metadata import prompt_metadata

fixture = json.loads((ROOT / "scripts/fixtures/builtin-styles-2026.9.13.json").read_text(encoding="utf-8"))
checks = 0
for lang in ("th", "en", "ja"):
    current = lang_style(lang)
    # Empty box = built-in; the current built-in pasted back = built-in.
    assert select_style(lang, "") == (current, "built_in_default_endpoint")
    assert select_style(lang, current) == (current, "saved_default")
    assert prompt_metadata(lang)["promptVersion"] == PROMPT_POLICY_VERSION[lang] == f"{lang}-style-m2-2026.10.17.1"
    checks += 3
    # A box still holding an earlier built-in is the user's text: sent as is.
    for kind in ("raw", "seeded"):
        old = fixture[kind][lang]
        style, source = select_style(lang, old)
        assert source == "saved_custom_replace", (lang, kind, source)
        assert style.split("\n", 1)[1].strip() == re.sub(r"\A[^\n]*\n", "", old.strip()).strip(), (lang, kind)
        checks += 1

th = lang_style("th")
assert th.startswith("ภาษาปลายทาง: ภาษาไทย\nทำหน้าที่นักแปลและบรรณาธิการมังงะภาษาไทย")
assert re.findall(r"^(\d)\. ", th, re.M) == ["1", "2", "3", "4", "5"]
for lang in ("en", "ja"):
    assert len(re.findall(r"^\d\. ", lang_style(lang), re.M)) == 5
assert len(th) < 1700 and len(lang_style("en")) < 2400 and len(lang_style("ja")) < 1000
checks += 4
src = (ROOT / "api/backend/ai/prompts/styles.py").read_text(encoding="utf-8")
assert "HISTORICAL" not in src, "no automatic replacement of saved style text"
print(f"builtin style M2 2026.10.17.2: {checks + 1} checks passed")
