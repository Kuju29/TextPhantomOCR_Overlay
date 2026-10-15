"""API parity for source-aware third-script validation."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.jobs.stages.ai_repair import _target_script_diagnostic


def diagnose(output: str, source: str):
    return _target_script_diagnostic(output, "th", source, "P0")


cyrillic = diagnose(
    "ฉันเกิดใหม่เป็นผู้หญิงบน пороге แห่งความตายแล้ว!!!",
    "I WAS REINCARNATED AS A GIRL ON THE VERGE OF DEATH...!",
)
assert cyrillic["decision"] == "reject", cyrillic
assert cyrillic["reason"] == "invented_third_script", cyrillic
assert cyrillic["detectedScripts"]["cyrillic"] == 6, cyrillic
assert "пороге" not in repr(cyrillic), cyrillic

preserved = diagnose(
    "เมื่อวานฉันพบ Александр ที่สถานี",
    "I met Александр at the station yesterday.",
)
assert preserved["decision"] == "accept", preserved
assert preserved["reason"] == "source_preserved_foreign_name", preserved

short_invented = diagnose(
    "นี่คือคำแปล Я ที่ผิด",
    "This is a translation",
)
assert short_invented["decision"] == "reject", short_invented
assert short_invented["reason"] == "invented_third_script", short_invented

for language in ("th", "ko"):
    for text in ("MAPLE TRANSLATION", "+ MAPLE TRANSLATION", "++ MAPLE TRANSLATIONS", "MAPLE TRANSLATION M", "@maple_translation"):
        item = _target_script_diagnostic(text, language, text, "P0")
        assert item["decision"] == "accept", (language, text, item)
    for text, source in (("THIS TRANSLATION", "THIS TRANSLATION"), ("NO TRANSLATION", "NO TRANSLATION"),
                         ("STOP TRANSLATION", "STOP TRANSLATION"), ("MAPLE TRANSLATION", "DIFFERENT TRANSLATION"),
                         ("THIS OUTPUT WAS NOT TRANSLATED AT ALL", "THIS OUTPUT WAS NOT TRANSLATED AT ALL"),
                         ("MAPLE TRANSLATION HELLO", "MAPLE TRANSLATION HELLO")):
        item = _target_script_diagnostic(text, language, source, "P0")
        assert item["decision"] == "reject", (language, text, item)

print("API source-aware third-script diagnostics passed: invented Cyrillic rejected, source-preserved name accepted.")
