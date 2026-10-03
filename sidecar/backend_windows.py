"""Windows backend: Win32 (winapi, display) + UI Automation (uia) + pynput (hooks) + mss.

Import only after display.set_dpi_awareness() has run (observer.py does that).
"""
from __future__ import annotations

import threading
from typing import Callable, Iterable, List, Optional

import mss
from PIL import Image

import display
import uia
import winapi
from hooks import Hooks
from model import ElementInfo, FocusInfo, HookEvent, MonitorInfo, Rect, WalkResult, WindowInfo

CHROMIUM_CLASS = "Chrome_WidgetWin_1"


class WindowsBackend:
    name = "windows"

    def __init__(self, own_pids: Iterable[int]):
        self.own_pids = set(own_pids)
        self._tls = threading.local()
        self._hooks: Optional[Hooks] = None

    # -- windows & displays ------------------------------------------------------

    def dpi_awareness(self) -> str:
        return display.current_awareness()

    def monitors(self) -> List[MonitorInfo]:
        return display.monitors()

    def _window_info(self, hwnd: int, popup: Optional[int] = None) -> Optional[WindowInfo]:
        if not hwnd:
            return None
        rect = winapi.window_rect(hwnd)
        if rect is None:
            return None
        pid = winapi.window_pid(hwnd)
        mon = display.monitor_for_window(hwnd)
        awareness, dpi = display.window_dpi_info(hwnd)
        popup_rect = winapi.window_rect(popup) if popup and popup != hwnd else None
        return WindowInfo(hwnd=hwnd, pid=pid, process=winapi.process_name(pid), title=winapi.window_text(hwnd),
                          class_name=winapi.class_name(hwnd), rect=rect, monitor=mon.id if mon else 0,
                          monitor_rect=mon.rect if mon else rect, monitor_scale=mon.scale if mon else 1.0,
                          window_dpi=dpi, dpi_awareness=awareness, minimized=winapi.is_minimized(hwnd),
                          popup_rect=popup_rect)

    def foreground(self) -> Optional[WindowInfo]:
        fg = winapi.foreground_hwnd()
        if not fg:
            return None
        owner = winapi.visible_root_owner(fg)
        return self._window_info(owner, popup=fg if owner != fg else None)

    def window_at(self, x: int, y: int) -> Optional[WindowInfo]:
        top = winapi.top_window_at(x, y)
        if not top:
            return None
        owner = winapi.visible_root_owner(top)
        return self._window_info(owner, popup=top if owner != top else None)

    # -- UI Automation --------------------------------------------------------------

    def browser_url(self, win: WindowInfo) -> Optional[str]:
        return uia.browser_url(win.hwnd)

    def private_window(self, win: WindowInfo, markers: List[str]) -> bool:
        return uia.private_window(win.hwnd, markers)

    def element_at(self, x: int, y: int, win: WindowInfo) -> Optional[ElementInfo]:
        return uia.element_at(x, y, self.own_pids, win.hwnd)

    def focused(self, tracked_types: frozenset) -> Optional[FocusInfo]:
        return uia.focused(tracked_types)

    def walk_text(self, win: WindowInfo, max_depth: int, max_elements: int, budget_s: float) -> Optional[WalkResult]:
        return uia.walk_text(win.hwnd, win.class_name == CHROMIUM_CLASS, max_depth, max_elements, budget_s)

    def rect_of(self, handle) -> Optional[Rect]:
        return uia.rect_of(handle)

    def web_document_empty(self, win: WindowInfo) -> Optional[bool]:
        return uia.web_document_empty(win.hwnd)

    def tree(self, win: WindowInfo, max_count: int, budget_s: float) -> List[ElementInfo]:
        return uia.tree(win.hwnd, win.class_name == CHROMIUM_CLASS, max_count, budget_s)

    # -- screen capture ------------------------------------------------------------------

    def capture(self, rect: Rect) -> Optional[Image.Image]:
        left, top, right, bottom = rect
        if right <= left or bottom <= top:
            return None
        sct = getattr(self._tls, "mss", None)
        if sct is None:  # one mss instance per thread
            sct = self._tls.mss = mss.mss()
        try:
            raw = sct.grab({"left": left, "top": top, "width": right - left, "height": bottom - top})
            return Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
        except Exception:
            return None

    # -- input -------------------------------------------------------------------------------

    def input_idle_s(self) -> Optional[float]:
        return winapi.input_idle_s()

    def start_hooks(self, sink: Callable[[HookEvent], None]) -> None:
        self._hooks = Hooks(sink, ctrl_down=winapi.ctrl_down)
        self._hooks.start()

    def restart_hooks(self) -> None:
        if self._hooks is not None:
            self._hooks.restart()

    def stop(self) -> None:
        if self._hooks is not None:
            self._hooks.stop()

    def thread_init(self):
        return uia.thread_init()
