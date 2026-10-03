"""Windows adapters exercised off Windows, against fakes of the libraries they call.

The fakes mirror the real APIs (checked against uiautomation 2.0.29 and
pynput 1.8 sources): Control.Name / ControlTypeName / AutomationId /
ClassName / BoundingRectangle(.left/.top/.right/.bottom) / ProcessId /
IsPassword / IsOffscreen / GetPattern(id) / GetFirstChildControl /
GetNextSiblingControl / GetRuntimeId, and pynput listeners that call
callbacks with an extra `injected` argument.
"""
import contextlib
import enum
import importlib
import sys
import types
from types import SimpleNamespace

import pytest

from commit import TRACKED_TYPES

# ----------------------------------------------------------------- fake uiautomation


class FakeRect:
    def __init__(self, l, t, r, b):
        self.left, self.top, self.right, self.bottom = l, t, r, b


class FakeRange:
    def __init__(self, text):
        self.text = text

    def GetText(self, n=-1):
        return self.text if n < 0 else self.text[:n]


class FakeTextPattern:
    def __init__(self, text):
        self._text = text

    def GetVisibleRanges(self):
        return [FakeRange(self._text)]

    @property
    def DocumentRange(self):
        return FakeRange(self._text)


class FakeValuePattern:
    def __init__(self, control):
        self._control = control

    @property
    def Value(self):
        self._control.value_reads += 1
        return self._control.value


class FakeControl:
    def __init__(self, ctype, name="", aid="", cls="", rect=(0, 0, 0, 0), pid=100, password=False,
                 offscreen=False, value=None, text=None, children=()):
        self.ctype, self._name, self._aid, self._cls, self._rect = ctype, name, aid, cls, rect
        self._pid, self._password, self._offscreen = pid, password, offscreen
        self.value, self.text, self.value_reads = value, text, 0
        self.children = list(children)
        self.parent = None
        for c in self.children:
            c.parent = self

    Name = property(lambda self: self._name)
    AutomationId = property(lambda self: self._aid)
    ClassName = property(lambda self: self._cls)
    ProcessId = property(lambda self: self._pid)
    IsPassword = property(lambda self: self._password)
    IsOffscreen = property(lambda self: self._offscreen)
    ControlTypeName = property(lambda self: self.ctype + "Control")
    BoundingRectangle = property(lambda self: FakeRect(*self._rect))

    def GetPattern(self, pattern_id):
        if pattern_id == 10002 and self.value is not None:
            return FakeValuePattern(self)
        if pattern_id == 10014 and self.text is not None:
            return FakeTextPattern(self.text)
        return None

    def GetFirstChildControl(self):
        return self.children[0] if self.children else None

    def GetNextSiblingControl(self):
        if self.parent is None:
            return None
        sibs = self.parent.children
        i = sibs.index(self)
        return sibs[i + 1] if i + 1 < len(sibs) else None

    def GetRuntimeId(self):
        return [42, id(self)]


class UiaState:
    def __init__(self):
        self.roots = {}
        self.focus = None
        self.at_point = {}


@pytest.fixture
def fake_uia(monkeypatch):
    state = UiaState()
    mod = types.ModuleType("uiautomation")
    mod.PatternId = SimpleNamespace(ValuePattern=10002, TextPattern=10014, LegacyIAccessiblePattern=10018)
    mod.Logger = SimpleNamespace(SetLogFile=lambda path: None)
    mod.UIAutomationInitializerInThread = lambda: contextlib.nullcontext()
    mod.ControlFromPoint = lambda x, y: state.at_point.get((x, y))
    mod.GetFocusedControl = lambda: state.focus
    mod.ControlFromHandle = lambda h: state.roots.get(h)
    monkeypatch.setitem(sys.modules, "uiautomation", mod)
    monkeypatch.delitem(sys.modules, "uia", raising=False)
    uia = importlib.import_module("uia")
    uia._tls.__dict__.clear()
    return uia, state


def chromium_window():
    omnibox = FakeControl("Edit", name="Address and search bar", cls="OmniboxViewViews", value="minierp.local/invoices/4471",
                          rect=(100, 40, 900, 70))
    badge = FakeControl("Button", name="InPrivate", rect=(10, 5, 80, 30))
    password = FakeControl("Edit", name="Password", password=True, value="hunter2", rect=(600, 500, 760, 525))
    pin = FakeControl("Edit", name="PIN", value="4821", rect=(600, 540, 760, 565))
    cost = FakeControl("Edit", name="Cost center", aid="costCenter", value="4711", rect=(600, 300, 760, 325))
    post = FakeControl("Button", name="Post", aid="post", rect=(780, 425, 850, 455))
    hidden = FakeControl("Text", name="Offscreen row", offscreen=True, rect=(0, 2000, 100, 2020))
    doc = FakeControl("Document", name="MiniERP", text="Invoice 4471\nSupplier: Müller GmbH", rect=(0, 80, 1280, 800),
                      children=[FakeControl("Text", name="Invoice 4471", rect=(40, 120, 300, 150)), cost, password, pin, post, hidden])
    toolbar = FakeControl("ToolBar", name="App bar", children=[omnibox, badge])
    root = FakeControl("Window", name="MiniERP - Microsoft Edge", cls="Chrome_WidgetWin_1", rect=(0, 0, 1280, 800),
                       children=[FakeControl("Pane", children=[toolbar]), doc])
    return root, dict(omnibox=omnibox, password=password, pin=pin, cost=cost, post=post, doc=doc, badge=badge)


def test_browser_url_finds_omnibox_and_caches(fake_uia):
    uia, state = fake_uia
    root, parts = chromium_window()
    state.roots[1] = root
    assert uia.browser_url(1) == "minierp.local/invoices/4471"
    parts["omnibox"].value = "online.mybank.com"
    assert uia.browser_url(1) == "online.mybank.com"  # cached control, fresh value
    assert uia.browser_url(999) is None


def test_private_badge_detected(fake_uia):
    uia, state = fake_uia
    root, _ = chromium_window()
    state.roots[1] = root
    assert uia.private_window(1, ["InPrivate", "Incognito"]) is True
    root2, parts2 = chromium_window()
    parts2["badge"]._name = "Profile: Work"
    state.roots[2] = root2
    assert uia.private_window(2, ["InPrivate", "Incognito"]) is False


def test_web_document_empty(fake_uia):
    uia, state = fake_uia
    root, parts = chromium_window()
    state.roots[1] = root
    assert uia.web_document_empty(1) is False
    parts["doc"].children = []
    uia._tls.__dict__.clear()
    assert uia.web_document_empty(1) is True
    state.roots[3] = FakeControl("Window", children=[FakeControl("Pane")])
    assert uia.web_document_empty(3) is None


def test_walk_text_never_reads_password_values(fake_uia):
    uia, state = fake_uia
    root, parts = chromium_window()
    state.roots[1] = root
    res = uia.walk_text(1, True, 10, 300, 1.5)
    names = [i.name for i in res.items]
    assert "Invoice 4471" in names and "Cost center" in names and "Offscreen row" not in names
    by_name = {i.name: i for i in res.items}
    assert by_name["Cost center"].value == "4711"
    assert by_name["Password"].is_password and by_name["Password"].value is None
    assert by_name["PIN"].value is None
    assert parts["password"].value_reads == 0 and parts["pin"].value_reads == 0
    assert res.doc_text.startswith("Invoice 4471")
    assert uia.rect_of(by_name["Post"].handle) == (780, 425, 850, 455)


def test_focused_reads_value_only_for_safe_fields(fake_uia):
    uia, state = fake_uia
    _, parts = chromium_window()
    state.focus = parts["cost"]
    f = uia.focused(TRACKED_TYPES)
    assert (f.name, f.control_type, f.value, f.is_password, f.rect) == ("Cost center", "Edit", "4711", False, (600, 300, 760, 325))
    assert f.key[0] == 42
    state.focus = parts["password"]
    assert uia.focused(TRACKED_TYPES).value is None and parts["password"].value_reads == 0
    state.focus = parts["pin"]
    assert uia.focused(TRACKED_TYPES).value is None and parts["pin"].value_reads == 0
    state.focus = parts["post"]
    assert uia.focused(TRACKED_TYPES).value is None  # buttons aren't tracked
    state.focus = None
    assert uia.focused(TRACKED_TYPES) is None


def test_element_at_and_overlay_fallback(fake_uia):
    uia, state = fake_uia
    root, parts = chromium_window()
    state.roots[1] = root
    state.at_point[(800, 440)] = parts["post"]
    el = uia.element_at(800, 440, {4242}, 1)
    assert (el.name, el.control_type, el.automation_id, el.rect, el.pid) == ("Post", "Button", "post", (780, 425, 850, 455), 100)
    # UIA hands back our own click-through overlay: search the app window instead.
    state.at_point[(650, 310)] = FakeControl("Pane", name="overlay", pid=4242, rect=(0, 0, 1920, 1080))
    el = uia.element_at(650, 310, {4242}, 1)
    assert el.name == "Cost center"
    assert uia.element_at(5, 5, {4242}, 77) is None


def test_tree_lists_named_pointable_elements(fake_uia):
    uia, state = fake_uia
    root, _ = chromium_window()
    state.roots[1] = root
    names = [(e.name, e.control_type) for e in uia.tree(1, True, 50, 1.5)]
    assert ("Post", "Button") in names and ("Cost center", "Edit") in names
    assert ("Offscreen row", "Text") not in names
    assert len(uia.tree(1, True, 2, 1.5)) == 2


def test_walk_respects_node_cap(fake_uia):
    uia, state = fake_uia
    big = FakeControl("Window", rect=(0, 0, 100, 100),
                      children=[FakeControl("Text", name=f"row {i}", rect=(0, i, 10, i + 1)) for i in range(500)])
    state.roots[5] = big
    res = uia.walk_text(5, False, 10, 50, 1.5)
    assert res.visited == 50 and res.truncated


def test_vanished_elements_are_tolerated(fake_uia):
    uia, state = fake_uia

    class Gone(FakeControl):
        @property
        def Name(self):
            raise OSError("UIA_E_ELEMENTNOTAVAILABLE")

    state.roots[6] = FakeControl("Window", rect=(0, 0, 100, 100), children=[Gone("Text", rect=(0, 0, 5, 5))])
    res = uia.walk_text(6, False, 10, 50, 1.5)
    assert res is not None and res.items == []


# ------------------------------------------------------------------------- fake pynput


@pytest.fixture
def fake_pynput(monkeypatch):
    created = []

    class Listener:
        def __init__(self, **callbacks):
            self.callbacks = callbacks
            self.daemon = False
            self.running = False
            created.append(self)

        def start(self):
            self.running = True

        def stop(self):
            self.running = False

    class Key(enum.Enum):
        enter = 1
        tab = 2
        esc = 3
        ctrl_l = 4
        shift = 5

    class KeyCode:
        def __init__(self, vk=None, char=None):
            self.vk, self.char = vk, char

    class Button(enum.Enum):
        left = 1
        right = 2
        middle = 3
        x1 = 4

    pkg = types.ModuleType("pynput")
    kb = types.ModuleType("pynput.keyboard")
    ms = types.ModuleType("pynput.mouse")
    kb.Listener, kb.Key, kb.KeyCode = Listener, Key, KeyCode
    ms.Listener, ms.Button = Listener, Button
    pkg.keyboard, pkg.mouse = kb, ms
    monkeypatch.setitem(sys.modules, "pynput", pkg)
    monkeypatch.setitem(sys.modules, "pynput.keyboard", kb)
    monkeypatch.setitem(sys.modules, "pynput.mouse", ms)
    return SimpleNamespace(created=created, Key=Key, KeyCode=KeyCode, Button=Button)


def test_hooks_map_keys_without_characters(fake_pynput):
    from hooks import Hooks
    events = []
    ctrl = {"down": False}
    h = Hooks(events.append, ctrl_down=lambda: ctrl["down"])
    h.start()
    mouse_l, kb_l = fake_pynput.created
    assert mouse_l.running and kb_l.running and mouse_l.daemon and kb_l.daemon
    press = kb_l.callbacks["on_press"]
    K, KC = fake_pynput.Key, fake_pynput.KeyCode
    press(K.enter, False)  # pynput 1.8 passes `injected`
    press(K.tab)           # pynput 1.7 doesn't
    press(K.esc, False)
    press(KC(vk=0x41, char="a"), False)
    ctrl["down"] = True
    press(KC(vk=0x53, char="\x13"), False)
    press(K.enter, False)
    kinds = [(e.kind, e.key) for e in events]
    assert kinds == [("key", "enter"), ("key", "tab"), ("key", "esc"), ("typing", ""), ("key", "ctrl+s"), ("key", "ctrl+enter")]
    assert all("a" not in vars(e).values() and "\x13" not in vars(e).values() for e in events)


def test_hooks_clicks_moves_scrolls(fake_pynput):
    from hooks import Hooks
    events = []
    h = Hooks(events.append)
    h.start()
    mouse_l = fake_pynput.created[0]
    B = fake_pynput.Button
    mouse_l.callbacks["on_click"](10.0, 20.0, B.left, True, False)
    mouse_l.callbacks["on_click"](10, 20, B.left, False, False)   # release: ignored
    mouse_l.callbacks["on_click"](10, 20, B.x1, True, False)      # side button: ignored
    mouse_l.callbacks["on_click"](30, 40, B.right, True)
    for _ in range(5):
        mouse_l.callbacks["on_move"](1, 2, False)                  # throttled to one per 100 ms
    mouse_l.callbacks["on_scroll"](1, 2, 0, -1, False)
    assert [(e.kind, e.button, e.x, e.y) for e in events if e.kind == "click"] == [("click", "left", 10, 20), ("click", "right", 30, 40)]
    assert sum(1 for e in events if e.kind == "move") == 1
    assert sum(1 for e in events if e.kind == "scroll") == 1
    h.stop()
    assert not any(l.running for l in fake_pynput.created)


def test_hook_callbacks_never_raise(fake_pynput):
    from hooks import Hooks

    def broken(_):
        raise RuntimeError("queue gone")
    h = Hooks(broken)
    h.start()
    mouse_l, kb_l = fake_pynput.created
    mouse_l.callbacks["on_click"](1, 1, fake_pynput.Button.left, True, False)
    kb_l.callbacks["on_press"](fake_pynput.Key.enter, False)


def test_hooks_restart_creates_new_listeners(fake_pynput):
    from hooks import Hooks
    h = Hooks(lambda e: None)
    h.start()
    h.restart()
    assert len(fake_pynput.created) == 4
    assert [l.running for l in fake_pynput.created] == [False, False, True, True]


# --------------------------------------------------------------------- Windows backend


@pytest.fixture
def fake_backend_windows(monkeypatch, fake_uia, fake_pynput):
    w = types.ModuleType("winapi")
    w.foreground_hwnd = lambda: 11  # a dropdown popup...
    w.visible_root_owner = lambda h: 10 if h == 11 else h  # ...owned by the app window 10
    w.top_window_at = lambda x, y: 11
    rects = {10: (0, 0, 1280, 800), 11: (600, 330, 900, 700)}
    w.window_rect = lambda h: rects.get(h)
    w.window_pid = lambda h: 100
    w.process_name = lambda pid: "msedge.exe"
    w.window_text = lambda h: "MiniERP - Microsoft Edge"
    w.class_name = lambda h: "Chrome_WidgetWin_1"
    w.is_minimized = lambda h: False
    w.input_idle_s = lambda: 0.25
    w.ctrl_down = lambda: False
    monkeypatch.setitem(sys.modules, "winapi", w)
    monkeypatch.delitem(sys.modules, "backend_windows", raising=False)
    return importlib.import_module("backend_windows")


def test_windows_backend_resolves_popups_to_owner(fake_backend_windows):
    b = fake_backend_windows.WindowsBackend([4242])
    win = b.foreground()
    assert win.hwnd == 10 and win.rect == (0, 0, 1280, 800) and win.popup_rect == (600, 330, 900, 700)
    assert win.process == "msedge.exe" and win.class_name == "Chrome_WidgetWin_1"
    assert b.window_at(700, 400).hwnd == 10
    assert b.input_idle_s() == 0.25 and b.name == "windows"


def test_windows_backend_uia_passthrough(fake_backend_windows, fake_uia):
    _, state = fake_uia
    root, parts = chromium_window()
    state.roots[10] = root
    b = fake_backend_windows.WindowsBackend([4242])
    win = b.foreground()
    assert b.browser_url(win) == "minierp.local/invoices/4471"
    assert b.private_window(win, ["InPrivate"]) is True
    assert b.web_document_empty(win) is False
    assert b.walk_text(win, 10, 300, 1.5).items
    assert any(e.name == "Post" for e in b.tree(win, 50, 1.5))
    with b.thread_init():
        pass


def test_windows_backend_hooks_lifecycle(fake_backend_windows, fake_pynput):
    b = fake_backend_windows.WindowsBackend([])
    b.start_hooks(lambda e: None)
    b.restart_hooks()
    b.stop()
    assert len(fake_pynput.created) == 4 and not any(l.running for l in fake_pynput.created)
