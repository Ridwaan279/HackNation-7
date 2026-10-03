"""UI Automation adapter (Windows only), built on the `uiautomation` package.

Import this only after display.set_dpi_awareness() (observer.py does that):
uiautomation sets per-monitor v1 awareness at import if nothing set it first.

Rules:
- Every call is wrapped: a vanished element raises COMError, which just means "no data".
- Tree walks are bounded by depth, node count and a deadline (big trees can be slow).
- Controls are never shared between threads (uiautomation forbids it): caches are thread-local.
- Values of password fields and password-like fields are never read.
"""
from __future__ import annotations

import re
import sys
import threading
import time
from contextlib import contextmanager
from typing import Callable, Dict, Iterator, List, Optional, Set, Tuple

import uiautomation as auto

from model import ElementInfo, FocusInfo, Rect, WalkItem, WalkResult
from redact import looks_like_password_field

auto.Logger.SetLogFile("")  # no @AutomationLog.txt next to the script (it could contain UI text)

PID_VALUE = auto.PatternId.ValuePattern
PID_TEXT = auto.PatternId.TextPattern
PID_LEGACY = auto.PatternId.LegacyIAccessiblePattern

VALUE_TYPES = frozenset({"Edit", "ComboBox", "Spinner"})
SKIP_TEXT_TYPES = frozenset({"ScrollBar", "Thumb", "Separator", "TitleBar", "MenuBar", "ToolTip"})
POINTABLE_TYPES = frozenset({"Button", "Edit", "ComboBox", "CheckBox", "RadioButton", "Hyperlink", "MenuItem",
                             "TabItem", "ListItem", "TreeItem", "DataItem", "Text", "SplitButton", "Spinner",
                             "Slider", "HeaderItem", "Image"})
_ADDRESS_NAME_RE = re.compile(r"add?ress|\burl\b|adresse|direcci", re.IGNORECASE)
_CHILD_LIMIT = 300
_tls = threading.local()


_timeouts_lock = threading.Lock()
_timeouts_done = False


CUIAUTOMATION8_CLSID = "{e22ad333-b25f-460c-83d0-0581107395c9}"


def _ensure_timeouts(connection_ms: int = 2000, transaction_ms: int = 3000) -> None:
    """Bound how long a hung app can block a UIA call (default: up to 20 s).

    The timeouts live on IUIAutomation2. uiautomation creates the Windows 7
    CUIAutomation object, which doesn't have it, so we create CUIAutomation8
    (Windows 8+, same API plus timeouts) and swap it into uiautomation's
    client before any element exists. Any failure keeps the defaults.
    """
    global _timeouts_done
    with _timeouts_lock:
        if _timeouts_done:
            return
        _timeouts_done = True
        try:
            client = auto.uiautomation._AutomationClient.instance()
            core = client.UIAutomationCore
            try:
                iface = client.IUIAutomation.QueryInterface(core.IUIAutomation2)
                swap = None
            except Exception:
                import comtypes.client
                swap = comtypes.client.CreateObject(CUIAUTOMATION8_CLSID, interface=core.IUIAutomation)
                iface = swap.QueryInterface(core.IUIAutomation2)
            iface.ConnectionTimeout = connection_ms
            iface.TransactionTimeout = transaction_ms
            if swap is not None:
                walker = swap.RawViewWalker
                client.IUIAutomation = swap
                client.ViewWalker = walker
            print(f"[observer] UIA timeouts set: connection {connection_ms} ms, transaction {transaction_ms} ms",
                  file=sys.stderr, flush=True)
        except Exception as ex:
            print(f"[observer] UIA timeouts: keeping the Windows defaults ({type(ex).__name__}); this is harmless",
                  file=sys.stderr, flush=True)


@contextmanager
def thread_init():
    """Initialise COM for UI Automation in the current thread (and bound UIA timeouts once)."""
    with auto.UIAutomationInitializerInThread():
        _ensure_timeouts()
        yield


def _cache(name: str) -> Dict[int, tuple]:
    c = getattr(_tls, name, None)
    if c is None:
        c = {}
        setattr(_tls, name, c)
    if len(c) > 64:
        c.clear()
    return c


def _safe(fn: Callable, default=None):
    try:
        return fn()
    except Exception:
        return default


def _ctype(c) -> str:
    name = _safe(lambda: c.ControlTypeName, "") or ""
    return name[:-7] if name.endswith("Control") else name


def _rect(c) -> Optional[Rect]:
    r = _safe(lambda: c.BoundingRectangle)
    if r is None or r.right <= r.left or r.bottom <= r.top:
        return None
    return (int(r.left), int(r.top), int(r.right), int(r.bottom))


def _value(c) -> Optional[str]:
    p = _safe(lambda: c.GetPattern(PID_VALUE))
    if p is not None:
        v = _safe(lambda: p.Value)
        if v is not None:
            return str(v)
    p = _safe(lambda: c.GetPattern(PID_LEGACY))
    if p is not None:
        v = _safe(lambda: p.Value)
        if v:
            return str(v)
    return None


def _children(c, limit: int, deadline: float) -> Iterator:
    child = _safe(c.GetFirstChildControl)
    n = 0
    while child is not None and n < limit and time.monotonic() < deadline:
        yield child
        n += 1
        child = _safe(child.GetNextSiblingControl)


def _walk(root, max_depth: int, max_nodes: int, deadline: float,
          prune: Optional[Callable[[object, str], bool]] = None) -> Iterator[Tuple[object, int, str]]:
    """Bounded depth-first walk in document order. Yields (control, depth, control_type)."""
    stack = [(root, 0)]
    seen = 0
    while stack and seen < max_nodes and time.monotonic() < deadline:
        c, depth = stack.pop()
        seen += 1
        ct = _ctype(c)
        yield c, depth, ct
        if depth >= max_depth or (prune is not None and prune(c, ct)):
            continue
        kids = list(_children(c, _CHILD_LIMIT, deadline))
        for k in reversed(kids):
            stack.append((k, depth + 1))


def _root(hwnd: int):
    return _safe(lambda: auto.ControlFromHandle(hwnd)) if hwnd else None


def _info(c) -> ElementInfo:
    return ElementInfo(name=_safe(lambda: c.Name, "") or "", control_type=_ctype(c),
                       automation_id=_safe(lambda: c.AutomationId, "") or "", rect=_rect(c),
                       is_password=bool(_safe(lambda: c.IsPassword, False)),
                       pid=int(_safe(lambda: c.ProcessId, 0) or 0), class_name=_safe(lambda: c.ClassName, "") or "")


# --------------------------------------------------------------------- clicks

def element_at(x: int, y: int, own_pids: Set[int], root_hwnd: int) -> Optional[ElementInfo]:
    """The element under a screen point. If UIA returns our own (click-through) overlay,
    search the clicked app window for the smallest element containing the point."""
    c = _safe(lambda: auto.ControlFromPoint(int(x), int(y)))
    pid = int(_safe(lambda: c.ProcessId, 0) or 0) if c is not None else 0
    if c is None or pid in own_pids:
        root = _root(root_hwnd)
        c = _deepest_at(root, x, y) if root is not None else None
        if c is None:
            return None
    return _info(c)


def _deepest_at(root, x: int, y: int, budget_s: float = 0.3):
    deadline = time.monotonic() + budget_s
    node = root
    for _ in range(40):
        best = None
        for k in _children(node, _CHILD_LIMIT, deadline):
            r = _rect(k)
            if r and r[0] <= x <= r[2] and r[1] <= y <= r[3]:
                area = (r[2] - r[0]) * (r[3] - r[1])
                if best is None or area < best[0]:
                    best = (area, k)
        if best is None:
            break
        node = best[1]
    return node


# ---------------------------------------------------------------------- focus

def focused(tracked_types: frozenset) -> Optional[FocusInfo]:
    c = _safe(auto.GetFocusedControl)
    if c is None:
        return None
    ct = _ctype(c)
    name = _safe(lambda: c.Name, "") or ""
    aid = _safe(lambda: c.AutomationId, "") or ""
    is_pw = bool(_safe(lambda: c.IsPassword, False))
    pid = int(_safe(lambda: c.ProcessId, 0) or 0)
    value = None
    if ct in tracked_types and not is_pw and not looks_like_password_field(name) and not looks_like_password_field(aid):
        value = _value(c)
    rid = _safe(c.GetRuntimeId)
    key = tuple(rid) if rid else (pid, aid, name, ct)
    return FocusInfo(key=key, name=name, control_type=ct, automation_id=aid, value=value, is_password=is_pw,
                     rect=_rect(c), pid=pid)


# --------------------------------------------------------------------- browsers

def browser_url(hwnd: int) -> Optional[str]:
    """Address-bar text of a browser window (Chromium: OmniboxViewViews; Firefox: urlbar-input)."""
    cache = _cache("omnibox")
    now = time.monotonic()
    hit = cache.get(hwnd)
    if hit is not None:
        ctl, t = hit
        if ctl is None and now - t < 10.0:
            return None  # searched recently and found nothing
        if ctl is not None:
            p = _safe(lambda: ctl.GetPattern(PID_VALUE))
            v = _safe(lambda: p.Value) if p is not None else None
            if v is not None:
                return v
    ctl = _find_omnibox(hwnd)
    cache[hwnd] = (ctl, now)
    if ctl is None:
        return None
    p = _safe(lambda: ctl.GetPattern(PID_VALUE))
    return _safe(lambda: p.Value) if p is not None else None


def _find_omnibox(hwnd: int):
    root = _root(hwnd)
    if root is None:
        return None
    fallback = None
    deadline = time.monotonic() + 0.3
    for c, _, ct in _walk(root, 14, 500, deadline, prune=lambda c, ct: ct == "Document"):
        if ct != "Edit":
            continue
        cls = _safe(lambda: c.ClassName, "") or ""
        aid = _safe(lambda: c.AutomationId, "") or ""
        if cls == "OmniboxViewViews" or aid == "urlbar-input":
            return c
        if fallback is None and _ADDRESS_NAME_RE.search(_safe(lambda: c.Name, "") or ""):
            fallback = c
    return fallback


def private_window(hwnd: int, markers: List[str]) -> bool:
    """Look for an InPrivate / Incognito badge in the browser toolbar (cached 60 s per window)."""
    cache = _cache("private")
    now = time.monotonic()
    hit = cache.get(hwnd)
    if hit is not None and now - hit[1] < 60.0:
        return hit[0]
    marks = [m.strip().lower() for m in markers if m.strip()]
    result = False
    root = _root(hwnd)
    if root is not None and marks:
        deadline = time.monotonic() + 0.3
        for c, _, ct in _walk(root, 10, 300, deadline, prune=lambda c, ct: ct == "Document"):
            if ct not in ("Button", "Text", "Image", "MenuItem", "Pane", "Group", "Custom"):
                continue
            name = (_safe(lambda: c.Name, "") or "").strip().lower()
            if name and any(name == m or name.startswith(m) for m in marks):
                result = True
                break
    cache[hwnd] = (result, now)
    return result


def _documents(hwnd: int, budget_s: float = 0.4) -> List[Tuple[object, int, Rect, str]]:
    """Visible web Documents in a Chromium/Electron window: (control, area, rect, name).

    The search doesn't descend into documents, so it only walks the browser's own UI.
    """
    root = _root(hwnd)
    out: List[Tuple[object, int, Rect, str]] = []
    if root is None:
        return out
    deadline = time.monotonic() + budget_s
    for c, _, ct in _walk(root, 18, 800, deadline, prune=lambda c, ct: ct == "Document"):
        if ct != "Document":
            continue
        r = _rect(c)
        if r is None or _safe(lambda: c.IsOffscreen, False):
            continue
        out.append((c, (r[2] - r[0]) * (r[3] - r[1]), r, _safe(lambda: c.Name, "") or ""))
    return out


def _find_document(hwnd: int):
    """The page the user is looking at: the largest visible Document (cached briefly).

    Edge can expose several Documents (side panels, split screen, built-in pages);
    the active page fills most of the window.
    """
    cache = _cache("document")
    now = time.monotonic()
    hit = cache.get(hwnd)
    if hit is not None and now - hit[1] < 5.0 and hit[0] is not None:
        if _safe(lambda: hit[0].Name, None) is not None:  # raises if the element is gone
            return hit[0]
    docs = _documents(hwnd)
    doc = max(docs, key=lambda d: d[1])[0] if docs else None
    cache[hwnd] = (doc, now)
    return doc


def document_diagnostics(hwnd: int) -> List[str]:
    """One line per visible Document (for spike.py): name, rect, and up to 20 direct children."""
    lines = []
    for c, area, r, name in sorted(_documents(hwnd), key=lambda d: -d[1]):
        kids = sum(1 for _ in _children(c, 20, time.monotonic() + 0.2))
        lines.append(f"{name[:40]!r} rect={r} children={kids}{'+' if kids >= 20 else ''}")
    return lines


def web_document_empty(hwnd: int) -> Optional[bool]:
    """True if the web document exposes no children (accessibility off), None if no document."""
    doc = _find_document(hwnd)
    if doc is None:
        return None
    return _safe(doc.GetFirstChildControl) is None


# ------------------------------------------------------------------ text & tree

def _visible_text(c, limit: int = 1024) -> Optional[str]:
    p = _safe(lambda: c.GetPattern(PID_TEXT))
    if p is None:
        return None
    parts: List[str] = []
    total = 0
    for r in (_safe(p.GetVisibleRanges) or [])[:20]:
        t = _safe(lambda: r.GetText(limit - total))
        if t:
            parts.append(t)
            total += len(t)
        if total >= limit:
            break
    if not parts:
        t = _safe(lambda: p.DocumentRange.GetText(limit))
        if t:
            parts.append(t)
    return "\n".join(parts) if parts else None


# Reading modes for walk_text() and tree():
#   "browser"  only the page (web Document). Never the browser's own UI: its tab strip holds the
#              titles of other tabs, which may be sites the privacy rules skip.
#   "web"      Electron and other Chromium-based apps: the page first, then the whole window.
#   "native"   everything else: the whole window.
READ_MODES = ("browser", "web", "native")


def walk_text(hwnd: int, mode: str, max_depth: int, max_elements: int, budget_s: float) -> Optional[WalkResult]:
    deadline = time.monotonic() + budget_s
    doc = _find_document(hwnd) if mode in ("browser", "web") else None
    res = _walk_text_from(doc, True, max_depth, max_elements, deadline) if doc is not None else None
    if mode == "browser":
        return res if res is not None else WalkResult()
    if res is None or not res.items:
        root = _root(hwnd)  # no page, or the page exposed nothing: read the window itself
        if root is None:
            return res
        res = _walk_text_from(root, False, max_depth, max_elements, max(deadline, time.monotonic() + budget_s / 2))
    return res


def _walk_text_from(root, root_is_doc: bool, max_depth: int, max_elements: int, deadline: float) -> WalkResult:
    res = WalkResult()
    first_doc = root if root_is_doc else None
    for c, _, ct in _walk(root, max_depth, max_elements, deadline):
        res.visited += 1
        if ct in SKIP_TEXT_TYPES:
            continue
        if first_doc is None and ct == "Document":
            first_doc = c
        if _safe(lambda: c.IsOffscreen, False):
            continue
        name = _safe(lambda: c.Name, "") or ""
        is_pw = False
        value = None
        if ct in VALUE_TYPES:
            is_pw = bool(_safe(lambda: c.IsPassword, False))
            if not is_pw and not looks_like_password_field(name):
                value = _value(c)
        if not name and value is None and not is_pw:
            continue
        res.items.append(WalkItem(ct, name, value, is_pw, c))
    res.truncated = res.visited >= max_elements or time.monotonic() >= deadline
    if first_doc is not None and time.monotonic() < deadline + 0.5:
        res.doc_text = _visible_text(first_doc)
    return res


def rect_of(handle) -> Optional[Rect]:
    return _rect(handle) if handle is not None else None


def tree(hwnd: int, mode: str, max_count: int, budget_s: float) -> List[ElementInfo]:
    """Named, on-screen, pointable elements of a window (for point_at). Modes as for walk_text()."""
    deadline = time.monotonic() + budget_s
    doc = _find_document(hwnd) if mode in ("browser", "web") else None
    out = _pointable(doc, max_count, deadline) if doc is not None else []
    if not out and mode != "browser":
        root = _root(hwnd)
        if root is not None:
            out = _pointable(root, max_count, max(deadline, time.monotonic() + budget_s / 2))
    return out


def _pointable(root, max_count: int, deadline: float) -> List[ElementInfo]:
    out: List[ElementInfo] = []
    for c, _, ct in _walk(root, 25, 3000, deadline):
        if ct not in POINTABLE_TYPES or _safe(lambda: c.IsOffscreen, False):
            continue
        name = _safe(lambda: c.Name, "") or ""
        r = _rect(c)
        if not name.strip() or r is None:
            continue
        out.append(ElementInfo(name=name, control_type=ct, automation_id=_safe(lambda: c.AutomationId, "") or "",
                               rect=r, is_password=ct == "Edit" and bool(_safe(lambda: c.IsPassword, False)), pid=0))
        if len(out) >= max_count:
            break
    return out
