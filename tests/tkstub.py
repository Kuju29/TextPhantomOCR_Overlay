"""A deliberately strict tkinter stub.

Only the methods the launcher really uses are implemented, so a typo or a
missing attribute in the launcher raises AttributeError instead of being
swallowed by a permissive mock.
"""
from __future__ import annotations

import sys
import types

CALLS: dict[str, int] = {}


class TclError(Exception):
    pass


def _count(name: str) -> None:
    CALLS[name] = CALLS.get(name, 0) + 1


class Misc:
    _next_id = 0

    def __init__(self, master=None, **kw):
        Misc._next_id += 1
        self._id = Misc._next_id
        self._master = master
        self._kw = dict(kw)
        self._children: list["Misc"] = []
        self._packed = False
        if isinstance(master, Misc):
            master._children.append(self)

    # -- options
    def configure(self, cnf=None, **kw):
        if cnf:
            kw.update(cnf)
        for key in kw:
            if key not in _VALID_OPTIONS:
                raise TclError(f'unknown option "-{key}" for {type(self).__name__}')
        self._kw.update(kw)

    config = configure

    def cget(self, key):
        return self._kw.get(key, "")

    def __getitem__(self, key):
        return self._kw.get(key, "")

    def __setitem__(self, key, value):
        self._kw[key] = value

    # -- geometry managers
    def pack(self, **kw):
        self._packed = True

    def pack_forget(self):
        self._packed = False

    def pack_propagate(self, flag):
        pass

    def grid(self, **kw):
        self._packed = True

    def columnconfigure(self, *a, **kw):
        pass

    def rowconfigure(self, *a, **kw):
        pass

    # -- events
    def bind(self, seq, fn=None, add=None):
        _count("bind")

    def bind_all(self, seq, fn=None, add=None):
        _count("bind_all")

    def unbind_all(self, seq):
        _count("unbind_all")

    def winfo_children(self):
        return list(self._children)

    def winfo_screenwidth(self):
        return 1920

    def winfo_screenheight(self):
        return 1080

    def destroy(self):
        self._children.clear()

    def after(self, ms, fn=None, *args):
        if fn is not None:
            PENDING.append((ms, fn, args))
        return f"timer{len(PENDING)}"

    def clipboard_clear(self):
        pass

    def clipboard_append(self, text):
        CLIPBOARD.append(text)

    def option_add(self, *a, **kw):
        pass

    def focus_set(self):
        pass


PENDING: list[tuple[int, object, tuple]] = []
CLIPBOARD: list[str] = []

_VALID_OPTIONS = {
    "bg", "background", "fg", "foreground", "text", "font", "bd", "relief",
    "cursor", "activebackground", "activeforeground", "highlightthickness",
    "highlightbackground", "padx", "pady", "state", "disabledforeground",
    "wraplength", "justify", "anchor", "width", "height", "command",
    "variable", "textvariable", "values", "insertbackground",
    "selectbackground", "selectforeground", "wrap", "yscrollcommand",
    "xscrollcommand", "orient", "style", "show", "borderwidth", "image",
}


class Widget(Misc):
    pass


class Tk(Misc):
    def title(self, text):
        self._title = text

    def minsize(self, w, h):
        pass

    def geometry(self, spec):
        self._geometry = spec

    def protocol(self, name, fn):
        PROTOCOLS[name] = fn

    def mainloop(self):
        _count("mainloop")

    def update_idletasks(self):
        pass

    def tk_setPalette(self, *a, **k):
        pass


PROTOCOLS: dict[str, object] = {}


class Frame(Widget):
    pass


class Label(Widget):
    pass


class Button(Widget):
    def invoke(self):
        cmd = self._kw.get("command")
        if callable(cmd):
            return cmd()


class Entry(Widget):
    pass


class Text(Widget):
    def __init__(self, master=None, **kw):
        super().__init__(master, **kw)
        self._lines: list[str] = []
        self._tags: dict[str, dict] = {}

    def insert(self, index, text, *tags):
        self._lines.extend(text.splitlines())

    def delete(self, start, end=None):
        self._lines.clear()

    def get(self, start, end=None):
        return "\n".join(self._lines) + "\n"

    def see(self, index):
        pass

    def tag_configure(self, name, **kw):
        self._tags[name] = kw

    def yview(self, *a):
        pass

    def xview(self, *a):
        pass

    def index(self, spec):
        return f"{len(self._lines)}.0"


class Canvas(Widget):
    def create_window(self, coords, **kw):
        return 1

    def itemconfigure(self, item, **kw):
        pass

    def yview(self, *a):
        pass

    def yview_scroll(self, *a):
        pass

    def xview(self, *a):
        pass

    def bbox(self, tag):
        return (0, 0, 100, 100)


class Variable:
    def __init__(self, master=None, value=None, name=None):
        self._value = value

    def get(self):
        return self._value

    def set(self, value):
        self._value = value


class StringVar(Variable):
    def __init__(self, master=None, value="", name=None):
        super().__init__(master, "" if value is None else value, name)

    def get(self) -> str:
        return "" if self._value is None else str(self._value)


class BooleanVar(Variable):
    def __init__(self, master=None, value=False, name=None):
        super().__init__(master, bool(value), name)

    def get(self) -> bool:
        return bool(self._value)


class Event:
    def __init__(self, **kw):
        self.__dict__.update(kw)
        self.width = kw.get("width", 400)
        self.height = kw.get("height", 300)
        self.delta = kw.get("delta", 0)
        self.num = kw.get("num", 0)


# --------------------------------------------------------------------------- ttk
class Style:
    def __init__(self, master=None):
        self.entries: dict[str, dict] = {}

    def theme_use(self, name=None):
        return "clam"

    def configure(self, style, **kw):
        self.entries[style] = kw

    def map(self, style, **kw):
        pass

    def lookup(self, *a, **k):
        return ""


class TtkWidget(Misc):
    pass


class Scrollbar(TtkWidget):
    def set(self, first, last):
        pass


class Combobox(TtkWidget):
    def current(self, index=None):
        return 0


class Checkbutton(TtkWidget):
    pass


class Separator(TtkWidget):
    pass


def install() -> tuple[types.ModuleType, types.ModuleType]:
    tk = types.ModuleType("tkinter")
    for name, obj in {
        "Misc": Misc, "Widget": Widget, "Tk": Tk, "Frame": Frame, "Label": Label,
        "Button": Button, "Entry": Entry, "Text": Text, "Canvas": Canvas,
        "Variable": Variable, "StringVar": StringVar, "BooleanVar": BooleanVar,
        "Event": Event, "TclError": TclError,
    }.items():
        setattr(tk, name, obj)

    ttk = types.ModuleType("tkinter.ttk")
    for name, obj in {
        "Frame": TtkWidget, "Label": TtkWidget, "Entry": Entry,
        "Combobox": Combobox, "Checkbutton": Checkbutton, "Scrollbar": Scrollbar,
        "Style": Style, "Separator": Separator,
    }.items():
        setattr(ttk, name, obj)

    filedialog = types.ModuleType("tkinter.filedialog")
    filedialog.askdirectory = lambda **k: ""
    filedialog.asksaveasfilename = lambda **k: ""
    messagebox = types.ModuleType("tkinter.messagebox")
    MSG: list[tuple[str, str]] = []
    messagebox.records = MSG
    messagebox.showerror = lambda t, m=None, **k: MSG.append(("error", str(m)))
    messagebox.showwarning = lambda t, m=None, **k: MSG.append(("warn", str(m)))
    messagebox.showinfo = lambda t, m=None, **k: MSG.append(("info", str(m)))
    messagebox.askyesno = lambda t, m=None, **k: (MSG.append(("ask", str(m))), True)[1]

    tk.ttk, tk.filedialog, tk.messagebox = ttk, filedialog, messagebox
    sys.modules.update({"tkinter": tk, "tkinter.ttk": ttk,
                        "tkinter.filedialog": filedialog,
                        "tkinter.messagebox": messagebox})
    return tk, ttk
