"""Displays and DPI (PLAN §5.7): process awareness, monitors, per-window DPI.

Importable on any OS (returns neutral defaults off Windows) because
observer.py calls set_dpi_awareness() before importing anything else.
"""
from __future__ import annotations

import re
import sys
from typing import List, Optional, Tuple

from model import MonitorInfo

_AWARENESS = {0: "unaware", 1: "system", 2: "per_monitor"}
_PER_MONITOR_AWARE_V2 = -4
_MONITOR_DEFAULTTONEAREST = 2
_MDT_EFFECTIVE_DPI = 0
_MONITORINFOF_PRIMARY = 1

if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    try:
        _shcore = ctypes.WinDLL("shcore")
    except OSError:  # Windows 7
        _shcore = None

    def _opt(dll, name, restype, *argtypes):
        """A function that may not exist on older Windows versions (None if missing)."""
        if dll is None:
            return None
        try:
            f = getattr(dll, name)
        except AttributeError:
            return None
        f.restype = restype
        f.argtypes = list(argtypes)
        return f

    _SetProcessDpiAwarenessContext = _opt(_user32, "SetProcessDpiAwarenessContext", wintypes.BOOL, ctypes.c_void_p)
    _SetProcessDpiAwareness = _opt(_shcore, "SetProcessDpiAwareness", ctypes.c_long, ctypes.c_int)
    _SetProcessDPIAware = _opt(_user32, "SetProcessDPIAware", wintypes.BOOL)
    _GetThreadDpiAwarenessContext = _opt(_user32, "GetThreadDpiAwarenessContext", ctypes.c_void_p)
    _GetWindowDpiAwarenessContext = _opt(_user32, "GetWindowDpiAwarenessContext", ctypes.c_void_p, wintypes.HWND)
    _GetAwarenessFromDpiAwarenessContext = _opt(_user32, "GetAwarenessFromDpiAwarenessContext", ctypes.c_int, ctypes.c_void_p)
    _GetProcessDpiAwareness = _opt(_shcore, "GetProcessDpiAwareness", ctypes.c_long, wintypes.HANDLE, ctypes.POINTER(ctypes.c_int))
    _GetDpiForWindow = _opt(_user32, "GetDpiForWindow", wintypes.UINT, wintypes.HWND)
    _GetDpiForMonitor = _opt(_shcore, "GetDpiForMonitor", ctypes.c_long, wintypes.HMONITOR, ctypes.c_int,
                             ctypes.POINTER(wintypes.UINT), ctypes.POINTER(wintypes.UINT))
    _MonitorFromWindow = _opt(_user32, "MonitorFromWindow", wintypes.HMONITOR, wintypes.HWND, wintypes.DWORD)

    class _MONITORINFOEXW(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT),
                    ("dwFlags", wintypes.DWORD), ("szDevice", wintypes.WCHAR * 32)]

    _MONITORENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC,
                                          ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)
    _EnumDisplayMonitors = _opt(_user32, "EnumDisplayMonitors", wintypes.BOOL, wintypes.HDC,
                                ctypes.POINTER(wintypes.RECT), _MONITORENUMPROC, wintypes.LPARAM)
    _GetMonitorInfoW = _opt(_user32, "GetMonitorInfoW", wintypes.BOOL, wintypes.HMONITOR,
                            ctypes.POINTER(_MONITORINFOEXW))


def set_dpi_awareness() -> str:
    """Make the process per-monitor DPI aware (v2 if available). Call before importing uiautomation."""
    if sys.platform != "win32":
        return "unknown"
    if _SetProcessDpiAwarenessContext is not None:
        # Fails harmlessly (returns FALSE) if awareness was already set.
        _SetProcessDpiAwarenessContext(ctypes.c_void_p(_PER_MONITOR_AWARE_V2))
    elif _SetProcessDpiAwareness is not None:
        _SetProcessDpiAwareness(2)
    elif _SetProcessDPIAware is not None:
        _SetProcessDPIAware()
    return current_awareness()


def current_awareness() -> str:
    if sys.platform != "win32":
        return "unknown"
    if _GetThreadDpiAwarenessContext is not None and _GetAwarenessFromDpiAwarenessContext is not None:
        return _AWARENESS.get(_GetAwarenessFromDpiAwarenessContext(_GetThreadDpiAwarenessContext()), "unknown")
    if _GetProcessDpiAwareness is not None:
        value = ctypes.c_int(-1)
        if _GetProcessDpiAwareness(None, ctypes.byref(value)) == 0:
            return _AWARENESS.get(value.value, "unknown")
    return "unknown"


def window_dpi_info(hwnd: int) -> Tuple[str, int]:
    """(DPI awareness of the window's process, the DPI the window sees). Unaware windows see 96."""
    if sys.platform != "win32":
        return "unknown", 96
    awareness = "unknown"
    if _GetWindowDpiAwarenessContext is not None and _GetAwarenessFromDpiAwarenessContext is not None:
        ctx = _GetWindowDpiAwarenessContext(hwnd)
        if ctx:
            awareness = _AWARENESS.get(_GetAwarenessFromDpiAwarenessContext(ctx), "unknown")
    dpi = _GetDpiForWindow(hwnd) if _GetDpiForWindow is not None else 0
    return awareness, int(dpi or 96)


def _monitor_dpi(hmon) -> int:
    if _GetDpiForMonitor is not None:
        x, y = wintypes.UINT(0), wintypes.UINT(0)
        if _GetDpiForMonitor(hmon, _MDT_EFFECTIVE_DPI, ctypes.byref(x), ctypes.byref(y)) == 0 and x.value:
            return int(x.value)
    return 96


def _monitor_info(hmon, index: int = 0) -> Optional[MonitorInfo]:
    if _GetMonitorInfoW is None or not hmon:
        return None
    mi = _MONITORINFOEXW()
    mi.cbSize = ctypes.sizeof(_MONITORINFOEXW)
    if not _GetMonitorInfoW(hmon, ctypes.byref(mi)):
        return None
    m = re.search(r"(\d+)\s*$", mi.szDevice or "")
    dpi = _monitor_dpi(hmon)
    rc, wk = mi.rcMonitor, mi.rcWork
    return MonitorInfo(id=int(m.group(1)) if m else index + 1, rect=(rc.left, rc.top, rc.right, rc.bottom),
                       work=(wk.left, wk.top, wk.right, wk.bottom), dpi=dpi, scale=round(dpi / 96.0, 4),
                       primary=bool(mi.dwFlags & _MONITORINFOF_PRIMARY))


def monitors() -> List[MonitorInfo]:
    if sys.platform != "win32" or _EnumDisplayMonitors is None:
        return []
    handles = []

    def collect(hmon, hdc, lprect, lparam):
        handles.append(hmon)
        return True

    callback = _MONITORENUMPROC(collect)  # keep a reference for the duration of the call
    _EnumDisplayMonitors(None, None, callback, 0)
    out = []
    for i, h in enumerate(handles):
        info = _monitor_info(h, i)
        if info:
            out.append(info)
    return out


def monitor_for_window(hwnd: int) -> Optional[MonitorInfo]:
    if sys.platform != "win32" or _MonitorFromWindow is None:
        return None
    return _monitor_info(_MonitorFromWindow(hwnd, _MONITOR_DEFAULTTONEAREST))
