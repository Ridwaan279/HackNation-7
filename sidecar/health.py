"""Accessibility health per app (PLAN §5.8): ok / weak / blind.

Evidence comes from text snapshots (named elements, characters), clicks
(did they land on a named element?), the Chromium empty-document check and
remote-session process names. A verdict needs ~20 s of active use, except
remote sessions, which are blind by definition.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Dict, List, Optional

VERDICT_AFTER_S = 20.0
WEB_EMPTY_RECHECK_S = 2.0
MIN_CLICKS = 3


@dataclass
class _App:
    active_s: float = 0.0
    named_max: int = 0
    text_max: int = 0
    snapshots: int = 0
    clicks: int = 0
    clicks_resolved: int = 0
    web_empty_since: Optional[float] = None
    web_empty_confirmed: bool = False
    remote: bool = False
    status: str = "unknown"  # last reported


class HealthTracker:
    def __init__(self):
        self._apps: Dict[str, _App] = {}
        self._lock = threading.Lock()

    def _app(self, key: str) -> _App:
        a = self._apps.get(key)
        if a is None:
            a = self._apps[key] = _App()
        return a

    def note_active(self, key: str, dt: float) -> None:
        with self._lock:
            self._app(key).active_s += max(0.0, dt)

    def note_snapshot(self, key: str, named_elements: int, text_chars: int) -> None:
        with self._lock:
            a = self._app(key)
            a.snapshots += 1
            a.named_max = max(a.named_max, named_elements)
            a.text_max = max(a.text_max, text_chars)

    def note_click(self, key: str, resolved: bool) -> None:
        with self._lock:
            a = self._app(key)
            a.clicks += 1
            a.clicks_resolved += 1 if resolved else 0

    def note_web_document(self, key: str, empty: Optional[bool], now: float) -> None:
        """Chromium/Electron only. Empty twice, >= 2 s apart, counts (the first query may wake a11y up)."""
        if empty is None:
            return
        with self._lock:
            a = self._app(key)
            if not empty:
                a.web_empty_since = None
                a.web_empty_confirmed = False
            elif a.web_empty_since is None:
                a.web_empty_since = now
            elif now - a.web_empty_since >= WEB_EMPTY_RECHECK_S:
                a.web_empty_confirmed = True

    def note_remote(self, key: str) -> None:
        with self._lock:
            self._app(key).remote = True

    def evaluate(self, key: str) -> Optional[dict]:
        """Return the a11y_health event fields when the status changed, else None."""
        with self._lock:
            a = self._app(key)
            resolution = (a.clicks_resolved / a.clicks) if a.clicks else 1.0
            reasons: List[str] = []
            hint = "none"
            if a.remote:
                status = "blind"
                reasons.append("remote-session window (no accessibility tree)")
                hint = "remote_session"
            else:
                if a.active_s < VERDICT_AFTER_S or a.snapshots == 0:
                    return None
                if a.web_empty_confirmed:
                    reasons.append("web document has no children")
                    hint = "chromium_flag"
                if a.named_max < 5:
                    reasons.append(f"only {a.named_max} named elements")
                if a.text_max < 50:
                    reasons.append(f"only {a.text_max} characters of text")
                if a.clicks >= MIN_CLICKS and resolution < 0.3:
                    reasons.append(f"only {round(resolution * 100)}% of clicks hit a named element")
                if reasons:
                    status = "blind"
                elif a.named_max < 15 or (a.clicks >= MIN_CLICKS and resolution < 0.6):
                    status = "weak"
                else:
                    status = "ok"
            if status == a.status:
                return None
            a.status = status
            return {
                "key": key,
                "status": status,
                "reasons": reasons,
                "score": {"named_elements": a.named_max, "text_chars": a.text_max,
                          "click_resolution": round(resolution, 3)},
                "hint": hint,
            }

    def status(self, key: str) -> str:
        with self._lock:
            return self._app(key).status
