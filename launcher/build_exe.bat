@echo off
rem ===========================================================================
rem  Build TextPhantomLocalAPI.exe  (one file, no console window)
rem
rem  Requires: Python 3.11 or 3.12 from python.org, 64-bit, "tcl/tk" included
rem            (it is ticked by default in the installer).
rem  Result:   dist\TextPhantomLocalAPI.exe
rem ===========================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
    echo [x] Python was not found on PATH.
    echo     Install Python 3.12 from https://www.python.org/downloads/windows/
    exit /b 1
)

python -c "import sys; sys.exit(0 if sys.version_info[:2] >= (3,10) else 1)"
if errorlevel 1 (
    echo [x] Python 3.10 or newer is required.
    exit /b 1
)

python -c "import tkinter" >nul 2>&1
if errorlevel 1 (
    echo [x] This Python has no tkinter. Re-run the Python installer and tick
    echo     "tcl/tk and IDLE", or install python3-tk.
    exit /b 1
)

if not exist ".venv" (
    echo [1/4] creating the build virtual environment ...
    python -m venv .venv || exit /b 1
)

echo [2/4] installing build + runtime packages ...
call .venv\Scripts\activate.bat || exit /b 1
python -m pip install --upgrade pip >nul
pip install -r requirements-launcher.txt || exit /b 1

echo [3/4] running PyInstaller ...
pyinstaller --noconfirm --clean --onefile --windowed ^
  --name TextPhantomLocalAPI ^
  --distpath dist --workpath build --specpath build ^
  --collect-all onnxruntime ^
  --collect-all cv2 ^
  --collect-all budoux ^
  --collect-submodules uvicorn ^
  --collect-submodules fastapi ^
  --collect-submodules starlette ^
  --collect-submodules pydantic ^
  --collect-submodules anyio ^
  --hidden-import h11 ^
  --hidden-import httptools ^
  --hidden-import websockets ^
  --hidden-import wsproto ^
  --hidden-import watchfiles ^
  --hidden-import PIL.Image ^
  --hidden-import PIL.ImageDraw ^
  --hidden-import PIL.ImageFont ^
  --hidden-import PIL.ImageFilter ^
  --exclude-module matplotlib ^
  --exclude-module scipy ^
  --exclude-module pandas ^
  --exclude-module IPython ^
  --exclude-module pytest ^
  textphantom_launcher.py || exit /b 1

echo [4/4] done.
echo.
if exist "dist\TextPhantomLocalAPI.exe" (
    for %%F in ("dist\TextPhantomLocalAPI.exe") do set SIZE=%%~zF
    set /a MB=!SIZE!/1048576
    echo     dist\TextPhantomLocalAPI.exe   ^(!MB! MB^)
    echo     Copy that single file anywhere and double-click it.
) else (
    echo [x] The exe was not produced - scroll up for the PyInstaller error.
    exit /b 1
)
endlocal
