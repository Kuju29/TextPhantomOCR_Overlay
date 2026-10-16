"""The one Chromium resolver for browser tests.

Order: the first set of TP_CHROMIUM, TP_QA_CHROMIUM, TP_BROWSER_EXECUTABLE
(an explicit path must exist), then a Playwright-managed full Chromium
(/opt/pw-browsers/chromium-*/chrome-linux/chrome, newest first), then common
system paths. Tests use it as ``executable_path=chromium_executable()`` or as
the default of a ``--browser`` option.
"""
import glob
import os
import re
from pathlib import Path

ENV_NAMES = ("TP_CHROMIUM", "TP_QA_CHROMIUM", "TP_BROWSER_EXECUTABLE")
SYSTEM_PATHS = ("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome")


def _revision(path):
    match = re.search(r"chromium-(\d+)", path)
    return int(match.group(1)) if match else -1


def chromium_executable(required=True):
    """Absolute path of a Chromium executable, or None when not required."""
    for name in ENV_NAMES:
        value = os.environ.get(name, "").strip()
        if value:
            if not Path(value).is_file():
                raise SystemExit(f"{name}={value} is not an executable file")
            return value
    managed = sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome"), key=_revision, reverse=True)
    for candidate in (*managed, *SYSTEM_PATHS):
        if Path(candidate).is_file():
            return candidate
    if required:
        raise SystemExit("No Chromium found: set TP_CHROMIUM (or TP_QA_CHROMIUM / TP_BROWSER_EXECUTABLE) "
                         "to a Chromium executable.")
    return None
