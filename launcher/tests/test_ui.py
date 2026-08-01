"""Builds the whole window against the strict tkinter stub.

This exercises every page builder, the language switch, the settings
round-trip and the button callbacks — the failure modes that would otherwise
only show up on the user's Windows machine.
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

import tkstub

tk, ttk = tkstub.install()

SANDBOX = Path("/tmp/tp-ui")
os.environ["XDG_DATA_HOME"] = str(SANDBOX)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import textphantom_launcher as L  # noqa: E402

API = Path(__file__).resolve().parent.parent.parent / "api"
FAILS: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    print(("  ok   " if cond else "  FAIL ") + name + (f"  {extra}" if extra else ""))
    if not cond:
        FAILS.append(name)


# The launcher must never reach the network in this test.
L.Updater.remote_commit = lambda self, src: (_ for _ in ()).throw(
    AssertionError("network access during UI test"))
L.Updater.check = lambda self, src: {"update_available": False, "local_sha": "deadbeef",
                                     "remote": {}, "reason": ""}

# Point the source at the real api folder so the prompt / advanced pages have
# something to read.
L.ensure_dirs()
L.save_settings({**L.DEFAULT_SETTINGS, "source": str(API), "lang": "en"})

print("\n== build window ==")
app = L.App()
check("window built", app is not None)
check("all six pages exist", set(app._pages) == {
    "dashboard", "settings", "prompt", "advanced", "source", "about"},
    str(sorted(app._pages)))
check("nav buttons built", len(app._nav_buttons) == 6)
check("i18n registry populated", len(app._i18n) > 40, f"{len(app._i18n)} widgets")
check("stdout is captured", isinstance(sys.stdout, L.StreamToBus))

print("\n== page switching ==")
for name in app._pages:
    app._show_page(name)
    check(f"show {name}", app._current_page == name)

print("\n== settings round-trip ==")
app.vars["__port"].set("8123")
app.vars["__host"].set("0.0.0.0")
app.vars["SERVER_MAX_WORKERS"].set("6")
app.vars["AI_API_KEY"].set("AIzaTESTKEY")
app.vars["TP_ACCESS_LOG_MODE"].set("uvicorn")
app.vars["__ai_temperature"].set("0.4")
app._save_from_ui()
stored = L.load_settings()
check("port saved", stored["port"] == 8123, str(stored["port"]))
check("host saved", stored["host"] == "0.0.0.0")
check("curated env saved", stored["env"]["SERVER_MAX_WORKERS"] == "6")
check("key saved", stored["env"]["AI_API_KEY"] == "AIzaTESTKEY")
check("temperature saved", stored["ai_temperature"] == "0.4")
env = L.build_env(stored)
check("env has the workers", env["SERVER_MAX_WORKERS"] == "6")
check("planned url uses 127.0.0.1 for 0.0.0.0",
      app._planned_url() == "http://127.0.0.1:8123", app._planned_url())

for bad in ("not-a-number", "0", "70000", "-5"):
    app.vars["__port"].set(bad)
    app._collect_settings()
    check(f"port {bad!r} rejected without crashing", app.settings["port"] == 8123,
          str(app.settings["port"]))
app.vars["__port"].set("7860")

print("\n== bad values are reported, not swallowed ==")
lines = [ln for _lvl, ln in app.bus.drain(999)]
check("port error logged", any("port must be a number" in ln for ln in lines),
      next((ln for ln in lines if "port must" in ln), ""))

print("\n== advanced page ==")
app._reload_advanced()
check("advanced rows generated", len(app.adv_vars) > 20, f"{len(app.adv_vars)} rows")
check("curated keys excluded from advanced",
      not (set(app.adv_vars) & L.CURATED_KEYS))
name = "TP_LENS_CACHE_MAX"
check(f"{name} present", name in app.adv_vars)
app.adv_vars[name].set("77")
app._save_from_ui()
check("advanced value saved", L.load_settings()["advanced_env"][name] == "77")
app.adv_vars[name].set("")
app._save_from_ui()
check("cleared advanced value removed",
      name not in L.load_settings().get("advanced_env", {}))

print("\n== the settings page follows the installed API ==")
check("schema built at startup", len(app.schema.specs) == len(L.CURATED),
      f"{len(app.schema.specs)} fields")
check("a widget exists for every live field",
      all(k in app.vars for k in app.schema.keys),
      str(sorted(app.schema.keys - set(app.vars))))
check("banner points at the extras but reports nothing hidden",
      app.schema_banner is not None
      and "Advanced page" in app.schema_banner["text"]
      and "hidden" not in app.schema_banner["text"],
      app.schema_banner["text"] if app.schema_banner else "no banner")

# Simulate an API update that drops most options and adds a new one.
shrunk = Path("/tmp/tp-ui/api-next")
shutil.rmtree(shrunk, ignore_errors=True)
(shrunk / "backend").mkdir(parents=True, exist_ok=True)
(shrunk / "backend" / "main.py").write_text("app = 1\n")
(shrunk / "backend" / "config.py").write_text(
    'a = _env_int("SERVER_MAX_WORKERS", 3)\n'
    'b = _env_str("TP_SHINY_NEW", "yes")\n', encoding="utf-8")
L.record_env_snapshot(L.discover_env_vars(API))          # baseline = old API
app.var_source.set(str(shrunk))
app._reload_schema()

check("vanished fields are gone from the page",
      "TP_VERTICAL_ROI" not in app.schema.keys and "AI_API_KEY" not in app.schema.keys,
      str(sorted(app.schema.keys)))
check("surviving field kept", "SERVER_MAX_WORKERS" in app.schema.keys)
check("its default now comes from the new source",
      next(s for s in app.schema.specs if s.key == "SERVER_MAX_WORKERS").default == "3")
check("a banner explains what happened", app.schema_banner is not None)
banner = app.schema_banner["text"]
check("banner names the hidden count", "hidden" in banner, banner[:80])
app._set_lang("th")
check("banner is translated too", "ซ่อน" in app.schema_banner["text"],
      app.schema_banner["text"][:60])
app._set_lang("en")

added, removed = L.record_env_snapshot(L.discover_env_vars(shrunk))
check("snapshot sees the new option", added == ["TP_SHINY_NEW"], str(added))
app._reload_advanced()
check("new option is on the advanced page", "TP_SHINY_NEW" in app.adv_vars)
check("nav badge counts it", app._nav_badges.get("advanced") == "● 1",
      str(app._nav_badges))
check("badge survives a language switch",
      (app._set_lang("th"), "● 1" in app._nav_buttons["advanced"]["text"])[1],
      app._nav_buttons["advanced"]["text"])
app._set_lang("en")
check("removed options are summarised", len(removed) > 10, f"{len(removed)} removed")

print("\n== cleaning up values the API no longer has ==")
app.settings["env"]["TP_VERTICAL_ROI"] = "false"      # left over from the old API
app.settings["advanced_env"]["TP_LENS_CACHE_MAX"] = "64"
app.settings["advanced_env"]["TP_SHINY_NEW"] = "keep-me"
orphans = app._orphan_setting_keys()
check("orphans detected", "TP_VERTICAL_ROI" in orphans and "TP_LENS_CACHE_MAX" in orphans,
      str(orphans))
check("still-valid values are not touched", "TP_SHINY_NEW" not in orphans)
app._cleanup_orphan_settings()
stored = L.load_settings()
check("orphans removed from disk",
      "TP_VERTICAL_ROI" not in stored["env"]
      and "TP_LENS_CACHE_MAX" not in stored["advanced_env"], str(stored["env"]))
check("valid value survived cleanup",
      stored["advanced_env"]["TP_SHINY_NEW"] == "keep-me")
check("cleanup button disabled once clean", app.btn_cleanup["state"] == "disabled")

# back to the real API for the remaining checks
app.var_source.set(str(API))
app._reload_schema()
L.record_env_snapshot(L.discover_env_vars(API))
app._reload_advanced()
check("page restored after pointing back at the full API",
      len(app.schema.specs) == len(L.CURATED) and app.schema_banner is not None,
      f"{len(app.schema.specs)} fields")

print("\n== prompt page ==")
app.var_prompt_lang.set("th")
app._load_prompt_into_box(True)
text = app.prompt_box.get("1.0", "end")
check("api default prompt loaded", len(text) > 1000, f"{len(text)} chars")
check("status line mentions the default", "API default" in app.prompt_status["text"],
      app.prompt_status["text"])
app.prompt_box.delete("1.0", "end")
app.prompt_box.insert("1.0", "MY CUSTOM THAI PROMPT")
app._save_prompt_override()
check("override stored", L.load_settings()["prompt_overrides"]["th"]
      == "MY CUSTOM THAI PROMPT")
app._load_prompt_into_box(False)
check("override reloaded", "override in use" in app.prompt_status["text"],
      app.prompt_status["text"])
app._clear_prompt_override()
check("override cleared", "th" not in L.load_settings().get("prompt_overrides", {}))

print("\n== language switch ==")
en_label = app._nav_buttons["settings"]["text"]
app._set_lang("th")
th_label = app._nav_buttons["settings"]["text"]
check("nav retranslated", en_label == "Settings" and th_label == "ตั้งค่า",
      f"{en_label!r} -> {th_label!r}")
check("settings labels retranslated",
      app._group_frames["field__SERVER_MAX_WORKERS"]["text"]
      == "จำนวน worker รวม (งานที่รันพร้อมกัน)",
      app._group_frames["field__SERVER_MAX_WORKERS"]["text"])
check("hint shows env name + default",
      "SERVER_MAX_WORKERS" in app._group_frames["hint__SERVER_MAX_WORKERS"]["text"],
      app._group_frames["hint__SERVER_MAX_WORKERS"]["text"][:60])
check("language persisted", L.load_settings()["lang"] == "th")
app._set_lang("en")
check("switch back", app._nav_buttons["settings"]["text"] == "Settings")

print("\n== status badge ==")
for state in (L.STATE_STOPPED, L.STATE_STARTING, L.STATE_RUNNING,
              L.STATE_STOPPING, L.STATE_ERROR):
    app._refresh_status(state, "detail")
    check(f"badge {state}", app.status_text["text"].startswith(
        L.STRINGS["en"][f"state.{state}"]), app.status_text["text"])
app._refresh_status(L.STATE_RUNNING)
check("start disabled while running", app.btn_start["state"] == "disabled")
check("stop enabled while running", app.btn_stop["state"] == "normal")
check("update blocked while running", app.btn_update["state"] == "disabled")
app._refresh_status(L.STATE_STOPPED)
check("start enabled when stopped", app.btn_start["state"] == "normal")
check("stop disabled when stopped", app.btn_stop["state"] == "disabled")

print("\n== log view ==")
app.bus.emit("hello world", "ok")
app.bus.emit("bad thing", "err")
app._tick()
body = app.log.get("1.0", "end")
check("log lines rendered", "hello world" in body and "bad thing" in body)
check("log tags configured", set(app.log._tags) == set(L.LEVELS), str(app.log._tags.keys()))
app.var_filter.set("err")
app._apply_log_filter()
app.bus.emit("info line", "info")
app.bus.emit("err line", "err")
app._tick()
check("filtered levels are elided, not thrown away",
      app.log._tags["info"].get("elide") is True
      and app.log._tags["err"].get("elide") is False,
      str(app.log._tags))
check("history is still in the widget", "info line" in app.log.get("1.0", "end"))
app.var_filter.set("all")
app._apply_log_filter()
check("clearing the filter un-elides everything",
      all(app.log._tags[lvl].get("elide") is False for lvl in L.LEVELS))

app.var_wrap.set(True)
app._apply_wrap()
check("wrap on -> word wrapping", app.log["wrap"] == "word", str(app.log["wrap"]))
check("wrap on -> no horizontal bar", app.log_hsb._packed is False)
app.var_wrap.set(False)
app._apply_wrap()
check("wrap off -> horizontal bar returns",
      app.log["wrap"] == "none" and app.log_hsb._packed is True)
check("horizontal bar uses a horizontal style",
      app.log_hsb["style"] == "TP.Horizontal.TScrollbar", app.log_hsb["style"])
app._copy_log()
check("copy log used the clipboard", bool(tkstub.CLIPBOARD))
app._clear_log()
check("clear log empties the widget", app.log.get("1.0", "end").strip() == "")

print("\n== api card ==")
app._refresh_api_card()
check("api card filled from install.json",
      str(API) in app.lbl_api_source["text"] or "not installed" in app.lbl_api_source["text"],
      app.lbl_api_source["text"][:60])

print("\n== update flow guards ==")
tkstub.PROTOCOLS and check("close handler registered", "WM_DELETE_WINDOW" in tkstub.PROTOCOLS)
app.controller.state = L.STATE_RUNNING
app._on_update_now()
check("update refused while the server runs",
      any("Stop the server" in m or "หยุดเซิร์ฟเวอร์" in m
          for _k, m in tk.messagebox.records),
      str(tk.messagebox.records[-1:]))
app.controller.state = L.STATE_STOPPED

print("\n== source field ==")
app.var_source.set("https://github.com/other/fork/tree/dev/api")
src = app._current_source()
check("source parsed from the field",
      (src.owner, src.repo, src.branch, src.subpath) == ("other", "fork", "dev", "api"))
check("effective api dir is the cache for github sources",
      app._effective_api_dir() == L.API_DIR)
app.var_source.set(str(API))
check("effective api dir is the folder for local sources",
      app._effective_api_dir() == API.resolve())
app.var_source.set("nonsense ###")
check("invalid source returns None and reports", app._current_source() is None)
app.var_source.set(L.DEFAULT_SOURCE)

print("\n== start guards (no server actually launched) ==")
started: list[tuple] = []
fetches: list[str] = []
L.ServerController.start = lambda self, s, d: started.append((s, d))
L.App._run_bg = lambda self, fn, then=None: fetches.append(getattr(fn, "__name__", "?"))

app.var_source.set(str(API))          # a usable local source
app._on_start()
check("start uses the local source folder",
      started and started[-1][1] == API.resolve(),
      str(started[-1][1]) if started else "not called")

app.var_source.set(L.DEFAULT_SOURCE)  # github, and the cache is empty here
started.clear()
app._on_start()
check("empty cache triggers a fetch instead of a start",
      not started and fetches == ["_do_update"], f"{started=} {fetches=}")
check("missing-source situation is logged",
      any("no API source cached" in ln for _l, ln in app.bus.drain(999)))

print("\n== timers scheduled ==")
check("periodic tick scheduled", any(fn.__name__ == "_tick" for _ms, fn, _a
                                     in tkstub.PENDING))
check("first-run scheduled", any(fn.__name__ == "_first_run" for _ms, fn, _a
                                 in tkstub.PENDING))
first_run = next(fn for _ms, fn, _a in tkstub.PENDING if fn.__name__ == "_first_run")
first_run()
check("first run completed without touching the network", True)

print("\n== close ==")
tkstub.PROTOCOLS["WM_DELETE_WINDOW"]()
check("settings saved on close", L.load_settings()["port"] == 7860)
check("stdout restored", sys.stdout is sys.__stdout__)

print("\n" + ("ALL UI CHECKS PASSED" if not FAILS else f"{len(FAILS)} FAILURES: {FAILS}"))
sys.exit(1 if FAILS else 0)
