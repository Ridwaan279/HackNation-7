"""App-scaling sanity checks and correction (PLAN §5.7).

Every click is checked: the click point must fall inside the rect that UI
Automation reports for the element under it. When 3 of the last 5 clicks in
an app miss, try scaling the rects by the monitor scale (or its inverse),
anchored at the screen origin or the window's monitor origin. A factor that
puts >= 80% of the recent clicks inside their rects is saved and applied to
every rect the sidecar emits for that app; otherwise the app is "untrusted"
and its pointer should use vision coordinates.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Dict, Optional, Tuple

from model import Rect

WINDOW = 5
TRIGGER = 3
TOLERANCE_PX = 2


def rect_contains(rect: Optional[Rect], x: int, y: int, tol: int = TOLERANCE_PX) -> bool:
    if not rect:
        return False
    l, t, r, b = rect
    return l - tol <= x <= r + tol and t - tol <= y <= b + tol


def rect_ok(rect: Optional[Rect]) -> bool:
    return bool(rect) and rect[2] > rect[0] and rect[3] > rect[1]


def apply_scale(rect: Rect, factor: float, anchor: Tuple[int, int]) -> Rect:
    ax, ay = anchor
    l, t, r, b = rect
    return (round(ax + (l - ax) * factor), round(ay + (t - ay) * factor),
            round(ax + (r - ax) * factor), round(ay + (b - ay) * factor))


@dataclass
class _Check:
    x: int
    y: int
    raw: Rect
    monitor_origin: Tuple[int, int]


@dataclass
class _AppState:
    status: str = "ok"  # 'ok' | 'corrected' | 'untrusted'
    factor: Optional[float] = None
    anchor: Optional[str] = None  # 'screen' | 'monitor'
    monitor_scale: float = 1.0
    history: Deque[Tuple[_Check, bool]] = field(default_factory=lambda: deque(maxlen=WINDOW))


@dataclass
class CheckResult:
    rect: Rect
    trusted: bool
    event: Optional[dict]  # app_scaling fields when the status changed


class ScalingTracker:
    def __init__(self):
        self._apps: Dict[str, _AppState] = {}

    def _state(self, key: str) -> _AppState:
        s = self._apps.get(key)
        if s is None:
            s = self._apps[key] = _AppState()
        return s

    def set_correction(self, key: str, factor: float, anchor: str) -> None:
        s = self._state(key)
        s.status, s.factor, s.anchor = "corrected", float(factor), anchor if anchor in ("screen", "monitor") else "screen"

    def status(self, key: str) -> str:
        return self._state(key).status

    def correct(self, key: str, rect: Optional[Rect], monitor_origin: Tuple[int, int]) -> Optional[Rect]:
        """Apply a saved correction to a rect (used for tree() and commit rects)."""
        s = self._apps.get(key)
        if rect is None or s is None or s.status != "corrected" or s.factor is None:
            return rect
        return apply_scale(rect, s.factor, (0, 0) if s.anchor == "screen" else monitor_origin)

    def check(self, key: str, x: int, y: int, raw: Optional[Rect], monitor_scale: float,
              monitor_origin: Tuple[int, int]) -> Optional[CheckResult]:
        if not rect_ok(raw):
            return None  # nothing to check against
        s = self._state(key)
        s.monitor_scale = monitor_scale
        rect = self.correct(key, raw, monitor_origin)
        inside = rect_contains(rect, x, y)
        s.history.append((_Check(x, y, raw, monitor_origin), inside))
        event = None

        misses = sum(1 for _, ok in s.history if not ok)
        if not inside and misses >= TRIGGER:
            event = self._reinfer(key, s)
            rect = self.correct(key, raw, monitor_origin)
            inside = rect_contains(rect, x, y)
        elif inside and s.status == "untrusted" and len(s.history) == WINDOW and misses == 0:
            s.status = "ok"
            event = {"key": key, "status": "ok"}
        return CheckResult(rect=rect, trusted=inside, event=event)

    def _reinfer(self, key: str, s: _AppState) -> Optional[dict]:
        previous = (s.status, s.factor, s.anchor)
        checks = [c for c, _ in s.history]
        scale = s.monitor_scale
        # "No correction" first: a corrected app may have moved to a 100% monitor.
        candidates = [(1.0, "screen")]
        if abs(scale - 1.0) >= 0.01:
            candidates += [(scale, "screen"), (scale, "monitor"), (1.0 / scale, "screen"), (1.0 / scale, "monitor")]
        best = None
        for factor, anchor in candidates:
            hits = sum(
                1 for c in checks
                if rect_contains(apply_scale(c.raw, factor, (0, 0) if anchor == "screen" else c.monitor_origin), c.x, c.y)
            )
            if hits >= max(TRIGGER, 0.8 * len(checks)) and (best is None or hits > best[0]):
                best = (hits, factor, anchor)
        if best and best[1] == 1.0:
            s.status, s.factor, s.anchor = "ok", None, None
        elif best:
            s.status, s.factor, s.anchor = "corrected", best[1], best[2]
        else:
            s.status, s.factor, s.anchor = "untrusted", None, None
        if best:
            # Re-score the history under the new rule so it doesn't re-trigger at once.
            factor, anchor = (s.factor or 1.0), (s.anchor or "screen")
            rescored = [(c, rect_contains(apply_scale(c.raw, factor, (0, 0) if anchor == "screen" else c.monitor_origin), c.x, c.y)) for c in checks]
            s.history.clear()
            s.history.extend(rescored)
        if (s.status, s.factor, s.anchor) == previous:
            return None
        event = {"key": key, "status": s.status}
        if s.status == "corrected":
            event["rect_scale"] = round(s.factor, 4)
            event["rect_anchor"] = s.anchor
        return event
