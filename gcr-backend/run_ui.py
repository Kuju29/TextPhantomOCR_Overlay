from __future__ import annotations
import importlib

import sys
import threading
import logging
import queue
from typing import Optional
from PySide6.QtGui import QTextCursor, QIcon

from pathlib import Path
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from PySide6.QtCore import QTimer, QObject, Signal
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QTextEdit, QLabel, QComboBox, QLineEdit, QSpinBox
)

import uvicorn

DEFAULT_MODULE_STR = "app.main:app" 
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8080
DEFAULT_LEVEL = "info"

LOG_QUEUE: "queue.Queue[str]" = queue.Queue(maxsize=5000)

if hasattr(sys, "_MEIPASS"):
    base_path = Path(sys._MEIPASS)
else:
    base_path = Path(__file__).parent
LOGO_PATH = base_path / "logo.png"

class QueueHandler(logging.Handler):
    def __init__(self, q: "queue.Queue[str]"):
        super().__init__()
        self.q = q
        self.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(message)s"))

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            try:
                self.q.put_nowait(msg)
            except queue.Full:
                try:
                    self.q.get_nowait()
                except Exception:
                    pass
                try:
                    self.q.put_nowait(msg)
                except Exception:
                    pass
        except Exception:
            self.handleError(record)

def attach_queue_handler(level_name: str = DEFAULT_LEVEL) -> QueueHandler:
    qh = QueueHandler(LOG_QUEUE)

    try:
        lvl = getattr(logging, level_name.upper())
    except AttributeError:
        lvl = logging.INFO

    logger_names = ("", "uvicorn", "uvicorn.error", "uvicorn.access", "fastapi", "asyncio")
    for name in logger_names:
        lg = logging.getLogger(name)
        if not any(isinstance(h, QueueHandler) for h in lg.handlers):
            lg.addHandler(qh)
        lg.setLevel(lvl)
        lg.propagate = True
    return qh

def _resolve_asgi_app(target: str):
    if ":" in target:
        mod_name, attr = target.split(":", 1)
    else:
        mod_name, attr = target, "app"
    module = importlib.import_module(mod_name)
    obj = module
    for part in attr.split("."):
        obj = getattr(obj, part)
    return obj

try:
    importlib.import_module("app.main")
except Exception:
    pass

class ServerController(QObject):
    stopped = Signal()

    def __init__(self, parent: Optional[QObject] = None) -> None:
        super().__init__(parent)
        self._thread: Optional[threading.Thread] = None
        self._server: Optional[uvicorn.Server] = None
        self._is_running = False

    def start(self, module_str: str, host: str, port: int, log_level: str) -> None:
        if self._is_running:
            logging.getLogger("ui").warning("Server already running")
            return

        attach_queue_handler(log_level)

        app_obj = _resolve_asgi_app(module_str)

        config = uvicorn.Config(app_obj,
            host=host,
            port=int(port),
            log_level=log_level,
            reload=False,
            log_config=None,
        )
        self._server = uvicorn.Server(config)

        def _run():
            try:
                self._is_running = True
                ok = self._server.run()
                logging.getLogger("ui").info("Uvicorn exited with status: %s", ok)
            except Exception:
                logging.getLogger("ui").exception("Server crashed")
            finally:
                self._is_running = False
                self.stopped.emit()

        self._thread = threading.Thread(target=_run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if not self._is_running or not self._server:
            return
        try:
            self._server.should_exit = True
            if self._thread and self._thread.is_alive():
                self._thread.join(timeout=5.0)
        except Exception:
            logging.getLogger("ui").exception("Error stopping server")
        finally:
            self._is_running = False
            self._server = None
            self._thread = None

class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("API Server Control")
        self.resize(960, 640)
        
        if LOGO_PATH.exists():
            self.setWindowIcon(QIcon(str(LOGO_PATH)))

        central = QWidget(self)
        self.setCentralWidget(central)
        root = QVBoxLayout(central)

        row1 = QHBoxLayout()
        root.addLayout(row1)

        row1.addWidget(QLabel("Module (package.module:app):"))
        self.edit_module = QLineEdit(DEFAULT_MODULE_STR, self)

        row1.addWidget(self.edit_module, stretch=2)

        row1.addWidget(QLabel("Host:"))
        self.edit_host = QLineEdit(DEFAULT_HOST, self)
        self.edit_host.setFixedWidth(140)
        row1.addWidget(self.edit_host)

        row1.addWidget(QLabel("Port:"))
        self.spin_port = QSpinBox(self)
        self.spin_port.setRange(1, 65535)
        self.spin_port.setValue(DEFAULT_PORT)
        row1.addWidget(self.spin_port)

        row1.addWidget(QLabel("Log level:"))
        self.level_combo = QComboBox(self)
        self.level_combo.addItems(["debug", "info", "warning", "error"])
        self.level_combo.setCurrentText(DEFAULT_LEVEL)
        row1.addWidget(self.level_combo)

        self.btn_start = QPushButton("Start API", self)
        self.btn_stop = QPushButton("Stop API", self)
        self.btn_clear = QPushButton("Clear Log", self)
        self.btn_stop.setEnabled(False)

        row1.addStretch(1)
        row1.addWidget(self.btn_start)
        row1.addWidget(self.btn_stop)
        row1.addWidget(self.btn_clear)

        self.log_view = QTextEdit(self)
        self.log_view.setReadOnly(True)
        root.addWidget(self.log_view, 1)

        self._srv = ServerController(self)
        self._srv.stopped.connect(self._on_server_stopped)

        self.btn_start.clicked.connect(self._on_start_clicked)
        self.btn_stop.clicked.connect(self._on_stop_clicked)
        self.btn_clear.clicked.connect(self.log_view.clear)

        self._timer = QTimer(self)
        self._timer.timeout.connect(self._drain_log_queue)
        self._timer.start(100)

    def _on_start_clicked(self) -> None:
        module_str = self.edit_module.text().strip() or DEFAULT_MODULE_STR
        host = self.edit_host.text().strip() or DEFAULT_HOST
        port = int(self.spin_port.value())
        level = self.level_combo.currentText()
        self._srv.start(module_str=module_str, host=host, port=port, log_level=level)
        self.btn_start.setEnabled(False)
        self.btn_stop.setEnabled(True)

    def _on_stop_clicked(self) -> None:
        self._srv.stop()
        self.btn_start.setEnabled(True)
        self.btn_stop.setEnabled(False)

    def _on_server_stopped(self) -> None:
        self.btn_start.setEnabled(True)
        self.btn_stop.setEnabled(False)

    def _drain_log_queue(self) -> None:
        got_any = False
        while True:
            try:
                msg = LOG_QUEUE.get_nowait()
            except Exception:
                break
            else:
                self.log_view.append(msg)
                got_any = True

        if got_any:
            self.log_view.moveCursor(QTextCursor.End)

    def closeEvent(self, event):
        try:
            self._srv.stop()
        finally:
            return super().closeEvent(event)

def main() -> None:
    attach_queue_handler(DEFAULT_LEVEL)
    logging.getLogger("ui").info("Launcher starting. Script dir: %s", SCRIPT_DIR)
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())

if __name__ == "__main__":
    main()
