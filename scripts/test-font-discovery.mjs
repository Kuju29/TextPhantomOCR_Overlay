import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const apiRoot = fileURLToPath(new URL("../api/", import.meta.url));
const python = process.env.PYTHON || process.env.PYTHON3 || "python";
const program = String.raw`
import contextlib
import io
import os
import shutil
import sys
import tempfile
import types

httpx = types.ModuleType("httpx")
network_calls = []
def forbidden_get(*args, **kwargs):
    network_calls.append((args, kwargs))
    raise AssertionError("font discovery must not call the network when a local face exists")
httpx.get = forbidden_get
sys.modules["httpx"] = httpx

from backend.render import fonts

installed = fonts._find_system_font(fonts._SCALABLE_FALLBACKS["latin"], "latin")
assert installed, "test host needs one scalable Latin face (the API runtime requires fonts too)"
assert fonts._font_supports_text(installed, "A")

with tempfile.TemporaryDirectory() as temporary:
    windows_root = os.path.join(temporary, "Windows")
    local_app_data = os.path.join(temporary, "LocalAppData")
    machine_fonts = os.path.join(windows_root, "Fonts")
    user_fonts = os.path.join(local_app_data, "Microsoft", "Windows", "Fonts")
    os.makedirs(machine_fonts)
    os.makedirs(user_fonts)

    old_windir = os.environ.get("WINDIR")
    old_local = os.environ.get("LOCALAPPDATA")
    os.environ["WINDIR"] = windows_root
    os.environ["LOCALAPPDATA"] = local_app_data
    try:
        discovered = fonts._system_font_dirs()
        assert machine_fonts in discovered
        assert user_fonts in discovered

        local_face = os.path.join(machine_fonts, "NotoSans-Regular.ttf")
        shutil.copyfile(installed, local_face)
        fonts._SYSTEM_FONT_DIRS = (machine_fonts, user_fonts)
        fonts._resolve_cache.clear()
        fonts._coverage_cache.clear()
        resolved = fonts.ensure_font("NotoSans-Regular.ttf", ["https://must-not-run.invalid/font.ttf"])
        assert resolved == local_face
        assert fonts._font_supports_text(resolved, "A")
        assert network_calls == []

        empty = os.path.join(temporary, "empty")
        os.makedirs(empty)
        fonts._SYSTEM_FONT_DIRS = (empty,)
        fonts._resolve_cache.clear()
        fonts._coverage_cache.clear()
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            assert fonts.ensure_font("MissingLatin.ttf", []) is None
        assert "no scalable fallback" in stderr.getvalue()
        try:
            fonts.pick_font("A", "MissingThai.ttf", "MissingLatin.ttf", 22)
        except fonts.UnsupportedFontError as exc:
            assert exc.script == "latin"
            assert "U+0041" in str(exc)
        else:
            raise AssertionError("a genuinely missing Latin face must remain an explicit error")
    finally:
        if old_windir is None:
            os.environ.pop("WINDIR", None)
        else:
            os.environ["WINDIR"] = old_windir
        if old_local is None:
            os.environ.pop("LOCALAPPDATA", None)
        else:
            os.environ["LOCALAPPDATA"] = old_local

print("Font discovery regression passed: Windows roots, local-first resolution, explicit missing-font error.")
`;

const result = spawnSync(python, ["-c", program], {
  cwd: apiRoot,
  encoding: "utf8",
  env: { ...process.env, PYTHONPATH: apiRoot },
});
assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
process.stdout.write(result.stdout);
