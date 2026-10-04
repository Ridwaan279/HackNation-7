"""Commit detection: turn polled field values into "the user entered X" events.

A commit is emitted when the focused field's value differs from its value
when it got focus (or from the last commit) and either:
  - focus moves away, or Enter/Tab is pressed  -> final=True
  - the value has been unchanged for 0.8 s       -> final=False (may still change)
Password fields and password-like names are never tracked.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

from model import FocusInfo, Rect
from redact import looks_like_password_field

TRACKED_TYPES = frozenset({"Edit", "ComboBox", "Spinner"})
IDLE_COMMIT_S = 0.8


@dataclass
class Commit:
    t: float
    field: str
    control_type: str
    old: str
    new: str
    rect: Optional[Rect]
    final: bool


def trackable(focus: Optional[FocusInfo]) -> bool:
    return (
        focus is not None
        and not focus.is_password
        and focus.control_type in TRACKED_TYPES
        and focus.value is not None
        and not looks_like_password_field(focus.name)
        and not looks_like_password_field(focus.automation_id)
    )


class CommitTracker:
    def __init__(self, idle_s: float = IDLE_COMMIT_S):
        self.idle_s = idle_s
        self._cur: Optional[FocusInfo] = None
        self._baseline = ""
        self._last = ""
        self._last_change = 0.0

    def reset(self) -> None:
        """Forget the current field without emitting anything (pause / off the record)."""
        self._cur = None

    def observe(self, focus: Optional[FocusInfo], now: float) -> List[Commit]:
        out: List[Commit] = []
        cur_key = self._cur.key if self._cur else None
        new_key = focus.key if focus else None
        if new_key != cur_key:
            if self._cur is not None:
                c = self._flush(now, final=True)
                if c:
                    out.append(c)
            self._cur = focus if trackable(focus) else None
            if self._cur is not None:
                self._baseline = self._last = focus.value or ""
                self._last_change = now
            return out
        if self._cur is None or focus is None:
            return out
        value = focus.value or ""
        if value != self._last:
            self._last = value
            self._last_change = now
            self._cur = focus  # keep the latest rect
        elif self._last != self._baseline and now - self._last_change >= self.idle_s:
            c = self._flush(now, final=False)
            if c:
                out.append(c)
        return out

    def flush_final(self, focus: Optional[FocusInfo], now: float) -> List[Commit]:
        """Enter / Tab / Ctrl+S: take the latest value and commit it as final."""
        out = self.observe(focus, now)
        if self._cur is not None and focus is not None and focus.key == self._cur.key:
            c = self._flush(now, final=True)
            if c:
                out.append(c)
        return out

    def _flush(self, now: float, final: bool) -> Optional[Commit]:
        if self._cur is None or self._last == self._baseline:
            return None
        c = Commit(t=now, field=self._cur.name or self._cur.automation_id or self._cur.control_type,
                   control_type=self._cur.control_type, old=self._baseline, new=self._last,
                   rect=self._cur.rect, final=final)
        self._baseline = self._last
        return c
