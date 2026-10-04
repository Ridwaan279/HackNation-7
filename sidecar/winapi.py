"""Win32 helpers via ctypes (Windows only, no third-party imports).

All coordinates are physical pixels: observer.py makes the process
per-monitor DPI aware before this module is used.
"""
from __future__ import annotations

import ctypes
import os
import sys
import time
from ctypes import wintypes
from typing import Dict, Optional, Tuple

if sys.platform != "win32":
    raise ImportError("winapi is Windows-only")

Rect = Tuple[int, int, int, int]

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
dwmapi = ctypes.WinDLL("dwmapi")

GA_ROOT = 2
GW_OWNER = 4
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
DWMWA_EXTENDED_FRAME_BOUNDS = 9
VK_CONTROL = 0x11


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


def _fn(dll, name, restype, *argtypes):
    f = getattr(dll, name)
    f.restype = restype
    f.argtypes = list(argtypes)
    return f


GetForegroundWindow = _fn(user32, "GetForegroundWindow", wintypes.HWND)
WindowFromPoint = _fn(user32, "WindowFromPoint", wintypes.HWND, wintypes.POINT)
GetAncestor = _fn(user32, "GetAncestor", wintypes.HWND, wintypes.HWND, wintypes.UINT)
GetWindow = _fn(user32, "GetWindow", wintypes.HWND, wintypes.HWND, wintypes.UINT)
IsWindowVisible = _fn(user32, "IsWindowVisible", wintypes.BOOL, wintypes.HWND)
IsIconic = _fn(user32, "IsIconic", wintypes.BOOL, wintypes.HWND)
GetWindowThreadProcessId = _fn(user32, "GetWindowThreadProcessId", wintypes.DWORD, wintypes.HWND,
                               ctypes.POINTER(wintypes.DWORD))
GetWindowTextLengthW = _fn(user32, "GetWindowTextLengthW", ctypes.c_int, wintypes.HWND)
GetWindowTextW = _fn(user32, "GetWindowTextW", ctypes.c_int, wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
GetClassNameW = _fn(user32, "GetClassNameW", ctypes.c_int, wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
GetWindowRect = _fn(user32, "GetWindowRect", wintypes.BOOL, wintypes.HWND, ctypes.POINTER(wintypes.RECT))
GetCursorPos = _fn(user32, "GetCursorPos", wintypes.BOOL, ctypes.POINTER(wintypes.POINT))
GetLastInputInfo = _fn(user32, "GetLastInputInfo", wintypes.BOOL, ctypes.POINTER(LASTINPUTINFO))
GetAsyncKeyState = _fn(user32, "GetAsyncKeyState", wintypes.SHORT, ctypes.c_int)
GetTickCount = _fn(kernel32, "GetTickCount", wintypes.DWORD)
OpenProcess = _fn(kernel32, "OpenProcess", wintypes.HANDLE, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
QueryFullProcessImageNameW = _fn(kernel32, "QueryFullProcessImageNameW", wintypes.BOOL, wintypes.HANDLE,
                                 wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD))
CloseHandle = _fn(kernel32, "CloseHandle", wintypes.BOOL, wintypes.HANDLE)
DwmGetWindowAttribute = _fn(dwmapi, "DwmGetWindowAttribute", ctypes.c_long, wintypes.HWND, wintypes.DWORD,
                            ctypes.c_void_p, wintypes.DWORD)


def _h(handle) -> int:
    return int(handle or 0)


def foreground_hwnd() -> int:
    return _h(GetForegroundWindow())


def visible_root_owner(hwnd: int) -> int:
    """The app window a popup/menu/dialog belongs to: follow owners while they are visible."""
    root = _h(GetAncestor(hwnd, GA_ROOT)) or hwnd
    for _ in range(10):
        owner = _h(GetWindow(root, GW_OWNER))
        if not owner or not IsWindowVisible(owner):
            break
        root = _h(GetAncestor(owner, GA_ROOT)) or owner
    return root


def top_window_at(x: int, y: int) -> int:
    """Top-level window under a screen point (0 if none)."""
    h = _h(WindowFromPoint(wintypes.POINT(int(x), int(y))))
    if not h:
        return 0
    return _h(GetAncestor(h, GA_ROOT)) or h


def window_pid(hwnd: int) -> int:
    pid = wintypes.DWORD(0)
    GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value)


_proc_cache: Dict[int, Tuple[str, float]] = {}


def process_name(pid: int) -> str:
    """Exe file name for a pid, e.g. "EXCEL.EXE" ("" if it can't be read). Cached for 60 s."""
    if pid <= 0:
        return ""
    hit = _proc_cache.get(pid)
    now = time.monotonic()
    if hit and now - hit[1] < 60:
        return hit[0]
    name = ""
    handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if handle:
        try:
            size = wintypes.DWORD(1024)
            buf = ctypes.create_unicode_buffer(size.value)
            if QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                name = os.path.basename(buf.value)
        finally:
            CloseHandle(handle)
    _proc_cache[pid] = (name, now)
    if len(_proc_cache) > 500:
        _proc_cache.clear()
    return name


def window_text(hwnd: int) -> str:
    n = GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def class_name(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    GetClassNameW(hwnd, buf, 256)
    return buf.value


def window_rect(hwnd: int) -> Optional[Rect]:
    """Visible frame bounds (DWM), without the invisible resize borders of GetWindowRect."""
    r = wintypes.RECT()
    if DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(r), ctypes.sizeof(r)) == 0:
        return (r.left, r.top, r.right, r.bottom)
    if GetWindowRect(hwnd, ctypes.byref(r)):
        return (r.left, r.top, r.right, r.bottom)
    return None


def is_minimized(hwnd: int) -> bool:
    return bool(IsIconic(hwnd))


def cursor_pos() -> Optional[Tuple[int, int]]:
    p = wintypes.POINT()
    return (p.x, p.y) if GetCursorPos(ctypes.byref(p)) else None


def input_idle_s() -> Optional[float]:
    """Seconds since the last keyboard/mouse input anywhere on the system."""
    info = LASTINPUTINFO()
    info.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if not GetLastInputInfo(ctypes.byref(info)):
        return None
    return ((GetTickCount() - info.dwTime) & 0xFFFFFFFF) / 1000.0


def ctrl_down() -> bool:
    return bool(GetAsyncKeyState(VK_CONTROL) & 0x8000)
