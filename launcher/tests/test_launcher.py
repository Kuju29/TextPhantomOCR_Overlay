"""Headless checks for the launcher's non-GUI logic (tkinter is stubbed)."""
from __future__ import annotations

import json
import shutil
import io
import os
import sys
import types
import zipfile
from pathlib import Path

# ---------------------------------------------------------------- tkinter stub
class _TclError(Exception):
    pass


class _W:  # generic widget base
    def __init__(self, *a, **k):
        self._kw = dict(k)

    def __getitem__(self, item):
        return self._kw.get(item, "")

    def configure(self, **k):
        self._kw.update(k)

    config = configure

    def pack(self, *a, **k):
        return None

    def grid(self, *a, **k):
        return None

    def bind(self, *a, **k):
        return None

    def winfo_children(self):
        return []


class _Var:
    def __init__(self, value=None, **k):
        self._v = value

    def get(self):
        return self._v

    def set(self, v):
        self._v = v


tk = types.ModuleType("tkinter")
for name in ("Tk", "Frame", "Button", "Label", "Text", "Canvas", "Misc", "Toplevel"):
    setattr(tk, name, type(name, (_W,), {}))
tk.Variable = _Var
tk.StringVar = type("StringVar", (_Var,), {})
tk.BooleanVar = type("BooleanVar", (_Var,), {})
tk.Event = type("Event", (object,), {})
tk.TclError = _TclError
ttk = types.ModuleType("tkinter.ttk")
for name in ("Frame", "Label", "Entry", "Combobox", "Checkbutton", "Scrollbar",
             "Style", "Separator", "Notebook"):
    setattr(ttk, name, type(name, (_W,), {}))
filedialog = types.ModuleType("tkinter.filedialog")
filedialog.askdirectory = lambda **k: ""
filedialog.asksaveasfilename = lambda **k: ""
messagebox = types.ModuleType("tkinter.messagebox")
messagebox.showerror = messagebox.showwarning = messagebox.showinfo = lambda *a, **k: None
messagebox.askyesno = lambda *a, **k: False
tk.ttk, tk.filedialog, tk.messagebox = ttk, filedialog, messagebox
sys.modules.update({"tkinter": tk, "tkinter.ttk": ttk,
                    "tkinter.filedialog": filedialog,
                    "tkinter.messagebox": messagebox})

SANDBOX = Path("/tmp/tp-data")
os.environ["XDG_DATA_HOME"] = str(SANDBOX)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import textphantom_launcher as L  # noqa: E402

FAILS: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    print(("  ok   " if cond else "  FAIL ") + name + (f"  {extra}" if extra else ""))
    if not cond:
        FAILS.append(name)


print("\n== paths ==")
check("data dir under XDG_DATA_HOME", str(L.DATA_DIR).startswith(str(SANDBOX)),
      str(L.DATA_DIR))
L.ensure_dirs()
check("dirs created", L.RUNTIME_DIR.is_dir() and (L.RUNTIME_DIR / "models").is_dir())

print("\n== parse_source ==")
cases = [
    ("https://github.com/Kuju29/TextPhantomOCR_Overlay/tree/main/api",
     ("github", "Kuju29", "TextPhantomOCR_Overlay", "main", "api")),
    ("https://github.com/Kuju29/TextPhantomOCR_Overlay",
     ("github", "Kuju29", "TextPhantomOCR_Overlay", "main", "api")),
    ("Kuju29/TextPhantomOCR_Overlay", ("github", "Kuju29", "TextPhantomOCR_Overlay",
                                       "main", "api")),
    ("https://github.com/o/r/tree/dev/server/api", ("github", "o", "r", "dev",
                                                    "server/api")),
    ("https://github.com/o/r.git", ("github", "o", "r", "main", "api")),
]
for raw, want in cases:
    src = L.parse_source(raw)
    got = (src.kind, src.owner, src.repo, src.branch, src.subpath)
    check(f"parse {raw}", got == want, f"got {got}")

src = L.parse_source(cases[0][0])
check("zip url", src.zip_url ==
      "https://codeload.github.com/Kuju29/TextPhantomOCR_Overlay/zip/refs/heads/main",
      src.zip_url)
check("commits api has path+sha", "path=api" in src.commits_api and "sha=main" in src.commits_api,
      src.commits_api)
check("label", src.label == "Kuju29/TextPhantomOCR_Overlay@main/api", src.label)

local = SANDBOX / "mylocalapi"
(local / "backend").mkdir(parents=True, exist_ok=True)
(local / "backend" / "main.py").write_text("app = 1\n")
lsrc = L.parse_source(str(local))
check("local folder detected", lsrc.kind == "local" and lsrc.local == local.resolve())
for bad in ("", "not a url at all!!", "https://gitlab.com/a/b"):
    try:
        L.parse_source(bad)
        check(f"rejects {bad!r}", False)
    except ValueError as exc:
        check(f"rejects {bad!r}", True, str(exc)[:60])

print("\n== settings ==")
s = L.load_settings()
check("defaults present", s["port"] == 7860 and s["source"] == L.DEFAULT_SOURCE)
s["env"]["AI_API_KEY"] = "secret-key"
s["env"]["SERVER_MAX_WORKERS"] = "6"
s["keep_api_key"] = False
L.save_settings(s)
reread = L.load_settings()
check("api key not persisted when disabled", "AI_API_KEY" not in reread["env"])
check("other env persisted", reread["env"]["SERVER_MAX_WORKERS"] == "6")
s["keep_api_key"] = True
s["env"]["AI_API_KEY"] = "secret-key"
L.save_settings(s)
check("api key persisted when enabled",
      L.load_settings()["env"]["AI_API_KEY"] == "secret-key")

print("\n== build_env ==")
s = L.load_settings()
s["env"].update({"TP_AI_MAX_CONCURRENCY": "auto", "TP_DEBUG": "", "TP_RATE_GATE": "false"})
s["advanced_env"] = {"TP_LENS_CACHE_MAX": "64", "TP_BLANK": ""}
env = L.build_env(s)
check("'auto' skipped", "TP_AI_MAX_CONCURRENCY" not in env)
check("blank skipped", "TP_DEBUG" not in env and "TP_BLANK" not in env)
check("curated kept", env["TP_RATE_GATE"] == "false")
check("advanced kept", env["TP_LENS_CACHE_MAX"] == "64")
check("model path absolute", env["TP_TEXTBLOCK_MODEL"].endswith(
    os.path.join("runtime", "models", L.MODEL_NAME)), env["TP_TEXTBLOCK_MODEL"])
s["advanced_env"]["TP_TEXTBLOCK_MODEL"] = "D:/custom.onnx"
check("user model path wins", L.build_env(s)["TP_TEXTBLOCK_MODEL"] == "D:/custom.onnx")

print("\n== env discovery against the real api source ==")
API = Path(__file__).resolve().parent.parent.parent / "api"
found = L.discover_env_vars(API)
names = {v.name for v in found}
check("found many knobs", len(found) > 40, f"{len(found)} found")
for expected in ("SERVER_MAX_WORKERS", "TP_CPU_CONCURRENCY", "TP_ACCESS_LOG_MODE",
                 "TP_GEMINI_THINKING", "TP_LENS_CACHE_MAX", "TP_BUBBLE_USE_YOLO",
                 "FIREBASE_URL", "TP_TEXTBLOCK_MODEL_URL", "BUDOUX_MODEL_PATH"):
    check(f"discovered {expected}", expected in names)
check("every curated key is really in the source",
      L.CURATED_KEYS <= names,
      f"missing: {sorted(L.CURATED_KEYS - names)}")
sample = {v.name: v for v in found}
check("default parsed for SERVER_MAX_WORKERS",
      sample["SERVER_MAX_WORKERS"].default == "15",
      sample["SERVER_MAX_WORKERS"].default)
check("kind parsed", sample["TP_CPU_CONCURRENCY"].kind == "int")
check("source file recorded", sample["TP_LENS_CACHE_MAX"].where == "backend/lens/client.py",
      sample["TP_LENS_CACHE_MAX"].where)
advanced = [v for v in found if v.name not in L.CURATED_KEYS]
check("advanced page would show the rest", len(advanced) > 25, f"{len(advanced)} rows")

print("\n== settings schema reconciliation ==")
schema = L.build_schema(API)
check("built-in layout used when the repo ships none", schema.origin == "built-in",
      schema.origin)
check("no curated field is stale against the real api", schema.hidden == [],
      str(schema.hidden))
check("every curated field survived", len(schema.specs) == len(L.CURATED))
check("the rest is offered as extra", len(schema.extra) > 20, str(len(schema.extra)))
workers = next(s for s in schema.specs if s.key == "SERVER_MAX_WORKERS")
check("default comes from the API source, not the exe", workers.default == "15",
      workers.default)
gemini = next(s for s in schema.specs if s.key == "TP_GEMINI_THINKING")
check("choice fields keep their kind", gemini.kind == "choice", gemini.kind)
key = next(s for s in schema.specs if s.key == "AI_API_KEY")
check("secret fields keep their kind", key.kind == "secret", key.kind)

# An API that dropped an option must not leave a dead control behind.
shrunk = SANDBOX / "api-shrunk"
shutil.rmtree(shrunk, ignore_errors=True)
(shrunk / "backend").mkdir(parents=True, exist_ok=True)
(shrunk / "backend" / "main.py").write_text("app = 1\n")
(shrunk / "backend" / "config.py").write_text(
    'a = _env_int("SERVER_MAX_WORKERS", 8)\n'
    'b = _env_bool("TP_DEBUG", False)\n'
    'c = _env_str("TP_BRAND_NEW_OPTION", "hello")\n', encoding="utf-8")
small = L.build_schema(shrunk)
kept = {s.key for s in small.specs}
check("only the options this API reads are shown",
      kept == {"SERVER_MAX_WORKERS", "TP_DEBUG"}, str(sorted(kept)))
check("removed options are reported as hidden",
      "TP_VERTICAL_ROI" in small.hidden and "AI_API_KEY" in small.hidden,
      f"{len(small.hidden)} hidden")
check("a brand new option is surfaced as extra",
      small.extra == ["TP_BRAND_NEW_OPTION"], str(small.extra))
check("its default is read from the source",
      next(s for s in small.specs if s.key == "SERVER_MAX_WORKERS").default == "8")
check("empty groups are dropped", set(small.groups) == {"server", "logging"},
      str(sorted(small.groups)))
check("the change is explained in the notes",
      any("hidden because" in m for _lvl, m in small.notes),
      str([m[:40] for _l, m in small.notes]))

print("\n== repo-supplied ui-settings.json ==")
(shrunk / "ui-settings.json").write_text(json.dumps({
    "groups": [{"id": "mine", "en": "My group", "th": "กลุ่มของฉัน"}],
    "fields": [
        {"key": "TP_BRAND_NEW_OPTION", "group": "mine", "kind": "str",
         "en": "Brand new", "th": "ของใหม่"},
        {"key": "SERVER_MAX_WORKERS", "group": "mine", "kind": "int",
         "en": "Workers", "th": "เวิร์กเกอร์"},
        {"key": "GONE_FROM_API", "group": "mine", "en": "Ghost", "th": "ผี"},
    ],
}, ensure_ascii=False), encoding="utf-8")
repo = L.build_schema(shrunk)
check("repo layout wins over the built-in one", repo.origin == "ui-settings.json",
      repo.origin)
check("repo fields are shown", {s.key for s in repo.specs}
      == {"TP_BRAND_NEW_OPTION", "SERVER_MAX_WORKERS"},
      str(sorted(s.key for s in repo.specs)))
check("a repo field the API does not read is still hidden",
      repo.hidden == ["GONE_FROM_API"], str(repo.hidden))
check("repo group titles are used", repo.groups["mine"] == ("My group", "กลุ่มของฉัน"))
check("repo labels are bilingual",
      next(s for s in repo.specs if s.key == "TP_BRAND_NEW_OPTION").th == "ของใหม่")
check("TP_DEBUG moved to extra because the repo layout omits it",
      "TP_DEBUG" in repo.extra, str(repo.extra))

(shrunk / "ui-settings.json").write_text("{ this is not json", encoding="utf-8")
broken = L.build_schema(shrunk)
check("a broken layout file falls back loudly, not silently",
      broken.origin == "built-in"
      and any(lvl == "err" for lvl, _m in broken.notes),
      str([m for _l, m in broken.notes])[:100])
(shrunk / "ui-settings.json").write_text(json.dumps(
    {"fields": [{"group": "x", "en": "no key here"}]}), encoding="utf-8")
broken2 = L.build_schema(shrunk)
check("a field without a key is rejected with a reason",
      any("has no 'key'" in m for _l, m in broken2.notes),
      str([m for _l, m in broken2.notes])[:120])
(shrunk / "ui-settings.json").unlink()

print("\n== update diff snapshot ==")
before = L.discover_env_vars(shrunk)
added, removed = L.record_env_snapshot(before)
check("first snapshot reports nothing as new", (added, removed) == ([], []),
      f"{added} {removed}")
(shrunk / "backend" / "config.py").write_text(
    'a = _env_int("SERVER_MAX_WORKERS", 8)\n'
    'd = _env_str("TP_ANOTHER_ONE", "x")\n', encoding="utf-8")
added, removed = L.record_env_snapshot(L.discover_env_vars(shrunk))
check("added options detected", added == ["TP_ANOTHER_ONE"], str(added))
check("removed options detected", removed == ["TP_BRAND_NEW_OPTION", "TP_DEBUG"],
      str(removed))
check("snapshot persisted for the next launch",
      L.read_env_snapshot()["added"] == ["TP_ANOTHER_ONE"])

print("\n== prompt reading ==")
for lang in ("th", "en", "ja"):
    try:
        text = L.read_default_prompt(API, lang)
        check(f"read prompt '{lang}'", len(text) > 50, f"{len(text)} chars")
    except Exception as exc:
        check(f"read prompt '{lang}'", False, repr(exc))
try:
    L.read_default_prompt(API, "xx-nonexistent")
    check("unknown lang falls back to 'default'", True)
except Exception as exc:
    check("unknown lang falls back to 'default'", False, repr(exc))
try:
    L.read_default_prompt(SANDBOX / "nope", "th")
    check("missing source raises", False)
except FileNotFoundError:
    check("missing source raises", True)

print("\n== zip install (offline, fake archive) ==")
fake = SANDBOX / "fake.zip"
with zipfile.ZipFile(fake, "w") as zf:
    zf.writestr("REPO-main/README.md", "root readme")
    zf.writestr("REPO-main/api/requirements.txt", "fastapi\nnumpy\n")
    zf.writestr("REPO-main/api/backend/main.py", "app = 'x'\n")
    zf.writestr("REPO-main/api/backend/config.py", "settings = 1\n")
    zf.writestr("REPO-main/api/backend/ai/prompts.py", "LANG_STYLE = {'th': 'hello'}\n")
    zf.writestr("REPO-main/api/NotoSansThai-Regular.ttf", b"x" * 20000)
    zf.writestr("REPO-main/api/models/manga-bubble-yolo.onnx", b"y" * 5000)
    zf.writestr("REPO-main/other/keep-out.py", "nope")

bus = L.LogBus()
up = L.Updater(bus)
src = L.parse_source("https://github.com/o/REPO/tree/main/api")


def fake_download(url, dest, log, progress=None, timeout=600):
    import shutil as sh
    sh.copy2(fake, dest)
    return dest


def no_commit(_self, _src):
    raise RuntimeError("offline")


L.http_download = fake_download
L.Updater.remote_commit = no_commit
info = up.install(src)
check("api installed", (L.API_DIR / "backend" / "main.py").is_file())
check("root files excluded", not (L.API_DIR / "README.md").exists())
check("other/ excluded", not (L.API_DIR / "other").exists())
check("file count recorded", info["files"] == 6, str(info.get("files")))
check("font copied to runtime", (L.RUNTIME_DIR / "NotoSansThai-Regular.ttf").is_file())
check("model copied to runtime",
      (L.RUNTIME_DIR / "models" / L.MODEL_NAME).is_file())
check("install.json written", L.read_install_info()["source_label"] == src.label)
check("commit failure was reported, not hidden",
      any("commit id could not be read" in line for _lvl, line in bus.drain(999)))

# a second install must not lose the runtime assets, and must warn about new deps
fake2 = SANDBOX / "fake2.zip"
with zipfile.ZipFile(fake2, "w") as zf:
    zf.writestr("REPO-main/api/requirements.txt", "fastapi\nnumpy\npolars>=1\n")
    zf.writestr("REPO-main/api/backend/main.py", "app = 'v2'\n")
    zf.writestr("REPO-main/api/backend/config.py", "settings = 2\n")
fake = fake2
bus2 = L.LogBus()
up2 = L.Updater(bus2)
up2.install(src)
lines = [line for _lvl, line in bus2.drain(999)]
check("v2 installed", (L.API_DIR / "backend" / "main.py").read_text().strip() == "app = 'v2'")
check("runtime assets survived the swap",
      (L.RUNTIME_DIR / "models" / L.MODEL_NAME).is_file()
      and (L.RUNTIME_DIR / "NotoSansThai-Regular.ttf").is_file())
check("new dependency warned loudly", any("polars" in ln for ln in lines),
      next((ln for ln in lines if "polars" in ln), ""))

# a broken archive must be refused and must NOT destroy the working install
bad = SANDBOX / "bad.zip"
with zipfile.ZipFile(bad, "w") as zf:
    zf.writestr("REPO-main/api/readme.txt", "no backend here")
fake = bad
try:
    L.Updater(L.LogBus()).install(src)
    check("invalid archive refused", False)
except RuntimeError as exc:
    check("invalid archive refused", "not usable" in str(exc), str(exc)[:70])
check("previous install intact after a refused update",
      (L.API_DIR / "backend" / "main.py").read_text().strip() == "app = 'v2'")

empty = SANDBOX / "empty.zip"
with zipfile.ZipFile(empty, "w") as zf:
    zf.writestr("REPO-main/nothing/here.txt", "x")
fake = empty
try:
    L.Updater(L.LogBus()).install(src)
    check("missing subpath reported", False)
except RuntimeError as exc:
    check("missing subpath reported", "nothing found under 'api'" in str(exc),
          str(exc)[:80])

print("\n== tmp cleanup ==")
(L.TMP_DIR / "api_old_123").mkdir(parents=True, exist_ok=True)
(L.TMP_DIR / "half.zip.part").write_bytes(b"x")
(L.TMP_DIR / "staging").mkdir(parents=True, exist_ok=True)
(L.TMP_DIR / "keep-me.txt").write_text("not ours to delete")
removed = L.cleanup_tmp(L.LogBus())
check("leftovers removed", removed == 3, str(removed))
check("unrelated files untouched", (L.TMP_DIR / "keep-me.txt").is_file())

print("\n== local source install ==")
info = L.Updater(L.LogBus()).install(lsrc)
check("local install records the folder", info["kind"] == "local"
      and info["path"] == str(local.resolve()))

print("\n== log bus / stream capture ==")
bus3 = L.LogBus()
stream = L.StreamToBus(bus3)
stream.write("[TextPhantom][ok] warmup.boot {}\n")
stream.write("partial line without newline")
stream.flush()
rows = bus3.drain(99)
check("two lines captured", len(rows) == 2, str(rows))
check("ok level detected", rows[0][0] == "ok", rows[0][0])
bus3.emit("Traceback (most recent call last):", L._guess_level("Traceback (most recent"))
check("traceback -> err", bus3.drain(1)[0][0] == "err")
check("stream is not a tty", stream.isatty() is False)

print("\n== misc ==")
check("port_in_use is False for a closed port", L.port_in_use("127.0.0.1", 59999) is False)
cfg = L.uvicorn_log_config(bus3)
check("uvicorn log handler points at this module",
      cfg["handlers"]["bus"]["()"].endswith(".BusLogHandler"),
      cfg["handlers"]["bus"]["()"])
check("BusLogHandler writes to the bus", (
    lambda: (L.BusLogHandler().emit(L.logging.LogRecord(
        "x", L.logging.ERROR, "f", 1, "boom", None, None)),
        bus3.drain(1)[0][0] == "err")[1])())
check("i18n tables have identical keys",
      set(L.STRINGS["en"]) == set(L.STRINGS["th"]),
      f"en-only={sorted(set(L.STRINGS['en']) - set(L.STRINGS['th']))} "
      f"th-only={sorted(set(L.STRINGS['th']) - set(L.STRINGS['en']))}")
missing_i18n = [f.key for f in L.CURATED if not f.en or not f.th]
check("every setting has both labels", not missing_i18n, str(missing_i18n))
check("group titles cover all groups",
      {f.group for f in L.CURATED} <= set(L.GROUP_TITLES))

print("\n" + ("ALL CHECKS PASSED" if not FAILS else f"{len(FAILS)} FAILURES: {FAILS}"))
sys.exit(1 if FAILS else 0)
