# TextPhantom Local API — launcher

A one-file desktop app that runs the TextPhantom OCR API **on your own
machine**, so your pages are not queued behind everyone else on the public
Hugging Face Space.

แอปไฟล์เดียวสำหรับรัน TextPhantom OCR API **บนเครื่องตัวเอง** จะได้ไม่ต้องไปต่อคิว
กับผู้ใช้คนอื่นบน Hugging Face Space สาธารณะ

```
launcher/
├─ textphantom_launcher.py     the whole app (single file)
├─ requirements-launcher.txt   what the exe must carry
├─ build_exe.bat               Windows build  → dist\TextPhantomLocalAPI.exe
├─ build_exe.sh                Linux / macOS build
└─ tests/                      headless checks (no GUI needed)
```

---

## 1. The idea / แนวคิด

| | |
|---|---|
| **The .exe** | Python runtime + the wheels (fastapi, uvicorn, numpy, opencv, Pillow, budoux, onnxruntime) + the window. Built once. |
| **The API code** | **Not** inside the exe. Downloaded from the GitHub URL you set in the UI and kept in a private cache. |

That split is the point: when `api/` changes on GitHub you press **Update now**
and get the new version — **no new .exe**.

การแยกแบบนี้คือหัวใจ: เวลาโค้ดใน `api/` บน GitHub เปลี่ยน แค่กด **อัปเดตเลย**
ก็ได้เวอร์ชันใหม่ **ไม่ต้องสร้าง .exe ใหม่**

Nothing is ever written next to the .exe. Everything lives in one private
folder (`Open cache folder` in the UI opens it):

ไม่มีไฟล์ใดถูกเขียนข้างๆ .exe เลย ทุกอย่างอยู่ในโฟลเดอร์ส่วนตัวโฟลเดอร์เดียว:

```
Windows : %LOCALAPPDATA%\TextPhantomLocalAPI\
macOS   : ~/Library/Application Support/TextPhantomLocalAPI/
Linux   : ~/.local/share/TextPhantomLocalAPI/

  api/            the cached api/ folder from GitHub
  runtime/        the server's working dir — Noto fonts + the ONNX model
                  (kept here on purpose so an API update never wipes them)
  settings.json   your settings (and the AI key, if you allow it)
  tmp/            download staging, cleared automatically
```

Logs are **never** written to disk. They live in the window only; use
*Save log…* if you want a copy. / log ไม่ถูกเขียนลงดิสก์ อยู่ในหน้าต่างอย่างเดียว

---

## 2. Build the exe / สร้างไฟล์ exe

**Requirements:** Python 3.11 or 3.12 (64-bit) from python.org, with the
*tcl/tk and IDLE* box ticked (it is ticked by default).

```bat
cd extension\launcher
build_exe.bat
```

The script makes a `.venv`, installs everything, runs PyInstaller, and prints
the result:

```
dist\TextPhantomLocalAPI.exe      (~300–420 MB)
```

Copy that single file anywhere — Desktop, USB stick — and double-click it.
Nothing else needs to be next to it.

คัดลอกไฟล์เดียวนี้ไปวางที่ไหนก็ได้ แล้วดับเบิลคลิกได้เลย ไม่ต้องมีไฟล์อื่นข้างๆ

> The exe is large because it contains onnxruntime and OpenCV. That is the
> price of "one file, no install". / ไฟล์ใหญ่เพราะรวม onnxruntime กับ OpenCV ไว้ในตัว

**Linux / macOS:** `bash build_exe.sh` (needs `python3-tk`).

### Run without building / รันโดยไม่ต้องสร้าง exe

```bash
pip install -r requirements-launcher.txt
python textphantom_launcher.py
```

---

## 3. First run / การใช้งานครั้งแรก

1. Double-click the exe. The window opens on **Source & update** if no API is
   cached yet. / เปิดโปรแกรม ครั้งแรกจะเด้งไปหน้า **ต้นทาง & อัปเดต**
2. Press **Update now** — the `api/` folder is downloaded (a few seconds).
3. Go to **Settings**, paste your **AI API key**, press **Save settings**.
4. Press **Start**. The badge turns green when `/health` answers.
5. Copy the address (`http://127.0.0.1:7860`) into the extension popup →
   **Custom API URL** (the ⟲ button next to it goes back to the public server).
   นำที่อยู่ไปวางในช่อง **Custom API URL** ในป๊อปอัปของส่วนขยาย

Press **Start** without a cached API and it fetches it for you first.

The detector weights (`manga-bubble-yolo.onnx`, ~20 MB) and the Noto fonts are
downloaded automatically the first time the AI layer needs them. Use
**Download detector model** on the *Source & update* page to get it out of the
way beforehand.

---

## 4. What the UI gives you / หน้าตาโปรแกรม

| Page | What it does |
|---|---|
| **Dashboard / หน้าหลัก** | Start · Stop · Restart, the local address, uptime, and the live colour-coded log. The level filter *hides* lines rather than dropping them, so switching back to *all* still shows the history; *Wrap lines* swaps the horizontal scrollbar for word wrapping. |
| **Settings / ตั้งค่า** | Host & port, worker counts, CPU gate, timeouts, AI key, rate limits, layout mode, ONNX sessions, log verbosity — each with its env-var name and the API's own default shown underneath. |
| **AI prompt / พรอมต์ AI** | Loads the API's built-in style prompt for a language and lets you replace it. Used when the extension does not send its own prompt. |
| **Advanced / ขั้นสูง** | **Auto-generated**: every `os.environ` / `_env_*` option found in the downloaded API source (29 extra options today). New API options appear here by themselves after an update. |
| **Source & update / ต้นทาง & อัปเดต** | The source URL, *Check update*, *Update now*, the installed commit, and the cache folder. |
| **About** | Paths, versions, endpoint list. |

Every label exists in **English and Thai**; the EN / ไทย switch is top-right and
is remembered.

Settings take effect **when the server next starts** — use **Restart**.
การตั้งค่าจะมีผล **เมื่อเริ่มเซิร์ฟเวอร์ครั้งถัดไป** ให้กด **เริ่มใหม่**

---

## 5. The source URL / ช่องต้นทาง

Editable on the *Source & update* page. Accepted forms:

```
https://github.com/Kuju29/TextPhantomOCR_Overlay/tree/main/api   ← default
https://github.com/YOU/YOUR-FORK/tree/dev/api                    ← any fork/branch
YOU/YOUR-FORK                                                    ← short form
D:\work\TextPhantom-v2\extension\api                             ← a folder on this PC
```

A **folder path is used in place** — no copying — so while you edit the API
locally, *Restart* is enough to load your changes.
ถ้าใส่เป็นพาธโฟลเดอร์ จะใช้โฟลเดอร์นั้นตรงๆ แก้โค้ดแล้วกด *เริ่มใหม่* ก็เห็นผลทันที

How the update works: the repo archive is downloaded from `codeload.github.com`,
only the sub-path you named is extracted, it is checked for
`backend/main.py` + `backend/config.py`, and only then does it replace the
cache. A broken download never damages a working install. The commit id comes
from the GitHub API, so *Check update* can tell you if anything changed
without downloading.

Updating is blocked while the server runs — stop it first.

---

## 6. Limits worth knowing / ข้อจำกัดที่ควรรู้

* **A new pip dependency needs a new exe.** The launcher compares the
  downloaded `requirements.txt` with the previous one and writes a loud warning
  in the log if the API starts requiring a package the exe does not carry. Then
  add it to `requirements-launcher.txt` and rebuild.
  ถ้า API เพิ่ม dependency ใหม่ ต้องสร้าง exe ใหม่ — โปรแกรมจะเตือนใน log ให้
* **The exe unpacks itself into `%TEMP%` while it runs** (`_MEI…`) and deletes
  that folder on exit — that is how PyInstaller one-file works. The folder you
  keep the exe in stays untouched.
  ตอนรัน exe จะแตกตัวเองไว้ใน `%TEMP%` แล้วลบทิ้งตอนปิด โฟลเดอร์ที่วาง exe ไม่มีอะไรงอกเพิ่ม
* **Windows SmartScreen / antivirus** may flag an unsigned PyInstaller exe the
  first time. *More info → Run anyway*, or sign it.
* **Firewall:** the default host `127.0.0.1` is this machine only. Use `0.0.0.0`
  to let another device on your LAN reach it — then Windows will ask to allow it.
* **`localhost` vs `127.0.0.1`.** The extension rewrites `127.0.0.1` to
  `localhost` before calling the API. After every start the launcher probes
  `http://localhost:PORT` as well and prints either
  *"reachable as http://localhost:… too"* or a warning telling you to switch
  **Host** to `0.0.0.0`. If the extension cannot connect, read that line first.
  ส่วนขยายจะเปลี่ยน `127.0.0.1` เป็น `localhost` เอง — โปรแกรมจะทดสอบให้แล้วบอกใน log
* **One window at a time.** A second launch shows "already running" instead of
  fighting over the port. / เปิดซ้ำจะเตือนว่าเปิดอยู่แล้ว
* **Updating needs internet.** Proxy settings from `HTTP_PROXY` / `HTTPS_PROXY`
  are honoured; the local health check deliberately bypasses the proxy.
* **The AI key is stored in plain text** in `settings.json` inside the cache
  folder. Untick *Remember the AI API key* to keep it out of the file.
  คีย์ AI เก็บเป็นข้อความธรรมดาใน `settings.json` — ถ้าไม่อยากให้บันทึก ให้ติ๊กออก
* **`api/` on GitHub does not contain the fonts or the ONNX model** (the
  archive is ~0.4 MB). The Noto fonts download on the first start and the
  detector model (~20 MB) on the first AI page; both are then cached in
  `runtime/` forever. *Download detector model* fetches it in advance.
* The first AI page is slower: the ONNX model loads then. Tick **Load ONNX
  model at start** to pay that cost during startup instead.

---

## 7. Tests / การทดสอบ

No GUI, no network, no server needed for the first two:

```bash
cd tests
python3 test_launcher.py    # paths, URL parsing, settings, updater, discovery
python3 test_ui.py          # builds every page against a strict tkinter stub
python3 test_server.py      # really starts the API, calls it, updates, restarts
```

`test_server.py` needs the API's own packages installed
(`pip install -r ../../api/requirements.txt`).
