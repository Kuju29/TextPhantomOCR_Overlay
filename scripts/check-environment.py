"""Report the actual test interpreter/dependencies. Never install or mutate environments."""
import importlib, importlib.metadata, json, os, platform, sys
modules = {"fastapi":"fastapi", "uvicorn":"uvicorn", "httpx":"httpx", "python-multipart":"multipart",
           "numpy":"numpy", "opencv-python-headless":"cv2", "Pillow":"PIL", "budoux":"budoux"}
rows = []; missing = []
for package, module in modules.items():
    try:
        importlib.import_module(module)
        try:
            version=importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            version="module present; distribution name differs"
        rows.append({"package":package,"version":version,"imported":True})
    except (ImportError, OSError) as error:
        missing.append(package); rows.append({"package":package,"imported":False,"errorType":type(error).__name__})
print(json.dumps({"python":sys.version.split()[0],"executable":sys.executable,"platform":platform.system(),
    "venv":sys.prefix!=sys.base_prefix,"configuredPython":os.environ.get("PYTHON"),"dependencies":rows,
    "note":"Activate the project venv so npm's python command and PYTHON point to the same interpreter. No packages were installed."},indent=2))
if missing:
    print("Missing/unloadable dependencies: "+", ".join(missing),file=sys.stderr)
    print("Install api/requirements.txt in a project-specific venv, not a shared agent environment.",file=sys.stderr)
    raise SystemExit(1)
