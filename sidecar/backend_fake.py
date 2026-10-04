"""In-memory backend for tests and `observer.py --fake` (runs on any OS).

Tests mutate its fields to simulate windows, focus, UI trees and screen
pixels; `FakeBackend.demo()` builds a small MiniERP-in-Edge scene.
"""
from __future__ import annotations

import contextlib
from collections import Counter
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from PIL import Image, ImageDraw

from model import ElementInfo, FocusInfo, HookEvent, MonitorInfo, Rect, WalkItem, WalkResult, WindowInfo


def make_window(hwnd: int = 1, pid: int = 100, process: str = "msedge.exe", title: str = "MiniERP - Microsoft Edge",
                class_name: str = "Chrome_WidgetWin_1", rect: Rect = (0, 0, 1280, 800), monitor: int = 1,
                monitor_rect: Rect = (0, 0, 1920, 1080), monitor_scale: float = 1.0, window_dpi: int = 96,
                dpi_awareness: str = "per_monitor", popup_rect: Optional[Rect] = None) -> WindowInfo:
    return WindowInfo(hwnd=hwnd, pid=pid, process=process, title=title, class_name=class_name, rect=rect,
                      monitor=monitor, monitor_rect=monitor_rect, monitor_scale=monitor_scale,
                      window_dpi=window_dpi, dpi_awareness=dpi_awareness, popup_rect=popup_rect)


def element(name: str, control_type: str, rect: Rect, pid: int = 100, automation_id: str = "",
            is_password: bool = False, value: Optional[str] = None) -> ElementInfo:
    return ElementInfo(name=name, control_type=control_type, automation_id=automation_id, rect=rect,
                       is_password=is_password, pid=pid, value=value)


class FakeBackend:
    name = "fake"

    def __init__(self):
        self.windows: Dict[int, WindowInfo] = {}
        self.fg: Optional[int] = None
        self.urls: Dict[int, Optional[str]] = {}
        self.private: Set[int] = set()
        self.elements: Dict[int, List[ElementInfo]] = {}
        # Exact-point overrides for element_at: what UI Automation returns at (x, y),
        # whatever rect it reports (lets tests simulate apps with bad scaling).
        self.hits: Dict[Tuple[int, int], ElementInfo] = {}
        self.focus: Optional[FocusInfo] = None
        self.walks: Dict[int, WalkResult] = {}
        self.web_empty: Dict[int, Optional[bool]] = {}
        self.monitor_list: List[MonitorInfo] = [MonitorInfo(1, (0, 0, 1920, 1080), (0, 0, 1920, 1040), 96, 1.0, True)]
        self.frame = 0  # change it to change the "screen" pixels
        self.idle: Optional[float] = None
        self.sink: Optional[Callable[[HookEvent], None]] = None
        self.restarts = 0
        self.calls: Counter = Counter()
        self.on_walk: Optional[Callable[[], None]] = None  # side effect hook for tests
        self.last_content_only: Optional[bool] = None

    # -- scene helpers -------------------------------------------------------

    def add_window(self, win: WindowInfo, url: Optional[str] = None, elements: List[ElementInfo] = (),
                   walk: Optional[WalkResult] = None, foreground: bool = True) -> WindowInfo:
        self.windows[win.hwnd] = win
        self.urls[win.hwnd] = url
        self.elements[win.hwnd] = list(elements)
        if walk is not None:
            self.walks[win.hwnd] = walk
        if foreground:
            self.fg = win.hwnd
        return win

    # -- Backend protocol ------------------------------------------------------

    def dpi_awareness(self) -> str:
        return "per_monitor"

    def monitors(self) -> List[MonitorInfo]:
        self.calls["monitors"] += 1
        return list(self.monitor_list)

    def foreground(self) -> Optional[WindowInfo]:
        self.calls["foreground"] += 1
        return self.windows.get(self.fg) if self.fg is not None else None

    def window_at(self, x: int, y: int) -> Optional[WindowInfo]:
        self.calls["window_at"] += 1
        order = ([self.fg] if self.fg in self.windows else []) + [h for h in self.windows if h != self.fg]
        for h in order:
            l, t, r, b = self.windows[h].rect
            if l <= x < r and t <= y < b:
                return self.windows[h]
        return None

    def browser_url(self, win: WindowInfo) -> Optional[str]:
        self.calls["browser_url"] += 1
        return self.urls.get(win.hwnd)

    def private_window(self, win: WindowInfo, markers: List[str]) -> bool:
        self.calls["private_window"] += 1
        return win.hwnd in self.private

    def element_at(self, x: int, y: int, win: WindowInfo) -> Optional[ElementInfo]:
        self.calls["element_at"] += 1
        if (x, y) in self.hits:
            return self.hits[(x, y)]
        best = None
        for el in self.elements.get(win.hwnd, []):
            if el.rect is None:
                continue
            l, t, r, b = el.rect
            if l <= x <= r and t <= y <= b:
                area = (r - l) * (b - t)
                if best is None or area < best[0]:
                    best = (area, el)
        return best[1] if best else None

    def focused(self, tracked_types: frozenset) -> Optional[FocusInfo]:
        self.calls["focused"] += 1
        return self.focus

    def walk_text(self, win: WindowInfo, max_depth: int, max_elements: int, budget_s: float,
                  content_only: bool = False) -> Optional[WalkResult]:
        self.calls["walk_text"] += 1
        self.last_content_only = content_only
        if self.on_walk:
            self.on_walk()
        return self.walks.get(win.hwnd)

    def rect_of(self, handle: Any) -> Optional[Rect]:
        return handle.get("rect") if isinstance(handle, dict) else None

    def web_document_empty(self, win: WindowInfo) -> Optional[bool]:
        self.calls["web_document_empty"] += 1
        return self.web_empty.get(win.hwnd)

    def tree(self, win: WindowInfo, max_count: int, budget_s: float, content_only: bool = False) -> List[ElementInfo]:
        self.calls["tree"] += 1
        self.last_content_only = content_only
        return list(self.elements.get(win.hwnd, []))[:max_count]

    def capture(self, rect: Rect):
        self.calls["capture"] += 1
        w, h = rect[2] - rect[0], rect[3] - rect[1]
        if w <= 0 or h <= 0:
            return None
        img = Image.new("RGB", (w, h), (235, 238, 245))
        draw = ImageDraw.Draw(img)
        # Fine black/white stripes everywhere: high local contrast, like text.
        for y in range(0, h, 4):
            draw.line([(0, y), (w, y)], fill=(20, 20, 20), width=1)
        # A large panel whose colour depends on the frame, so captures can "change".
        shade = (self.frame * 60) % 256
        draw.rectangle([w // 10, h // 3, w // 10 + w // 3, h // 3 + h // 3], fill=(shade, shade, shade))
        return img

    def input_idle_s(self) -> Optional[float]:
        return self.idle

    def start_hooks(self, sink: Callable[[HookEvent], None]) -> None:
        self.sink = sink

    def restart_hooks(self) -> None:
        self.restarts += 1

    def stop(self) -> None:
        self.sink = None

    def thread_init(self):
        return contextlib.nullcontext()

    # -- demo scene for `observer.py --fake` -------------------------------------

    @classmethod
    def demo(cls) -> "FakeBackend":
        b = cls()
        items = [
            WalkItem("Text", "Invoice 4471", None, False, {"rect": (40, 120, 300, 150)}),
            WalkItem("Text", "Supplier: Müller GmbH", None, False, {"rect": (40, 160, 400, 190)}),
            WalkItem("Edit", "Cost center", "4711", False, {"rect": (600, 300, 760, 325)}),
            WalkItem("Edit", "Notes", "Pay to DE89 3704 0044 0532 0130 00", False, {"rect": (600, 360, 1000, 385)}),
            WalkItem("Button", "Post", None, False, {"rect": (780, 425, 850, 455)}),
        ]
        b.add_window(
            make_window(),
            url="minierp.local/invoices/4471",
            elements=[
                element("Cost center", "Edit", (600, 300, 760, 325), automation_id="costCenter"),
                element("Post", "Button", (780, 425, 850, 455), automation_id="post"),
            ],
            walk=WalkResult(items=items, visited=len(items)),
        )
        return b
