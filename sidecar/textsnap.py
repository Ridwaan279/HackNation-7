"""Ambient text snapshots (PLAN §5.2): visible text -> masked, de-duplicated deltas."""
from __future__ import annotations

import re
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Hashable, List, Optional, Tuple

from model import WalkItem
from redact import Redactor, looks_like_password_field

MAX_LINE_CHARS = 300
MAX_DELTA_BYTES = 4096
DOC_CHARS = 1024
MAX_SEEN_LINES = 3000
MAX_WINDOWS = 50
VALUE_TYPES = frozenset({"Edit", "ComboBox", "Spinner"})

_WS_RE = re.compile(r"\s+")


@dataclass
class SnapshotResult:
    delta: List[str]
    named_elements: int
    text_chars: int
    sensitive: List[Any] = field(default_factory=list)  # handles of password / masked items


def _norm(text: Optional[str]) -> str:
    if not text:
        return ""
    t = _WS_RE.sub(" ", text).strip()
    return t[:MAX_LINE_CHARS]


def _meaningful(line: str) -> bool:
    return len(line) >= 2 and any(ch.isalnum() for ch in line)


def classify(items: List[WalkItem], redactor: Redactor) -> Tuple[List[str], List[Any], int]:
    """Masked lines, handles of sensitive items (password or masked), and the named-element count.

    Stateless, so the engine can also use it for a quick "where are the secrets" scan
    before a screenshot without affecting what the ambient text stream has seen.
    """
    lines: List[str] = []
    sensitive: List[Any] = []
    named = 0
    for item in items:
        name = _norm(item.name)
        if name:
            named += 1
        if item.is_password or (item.control_type in VALUE_TYPES and looks_like_password_field(item.name)):
            if item.handle is not None:
                sensitive.append(item.handle)
            if name:
                lines.append(redactor.redact(name))
            continue
        masked_any = False
        for raw in (name, _norm(item.value) if item.control_type in VALUE_TYPES else ""):
            if raw and _meaningful(raw):
                text, changed = redactor.redact_with_flag(raw)
                masked_any = masked_any or changed
                lines.append(text)
        if masked_any and item.handle is not None:
            sensitive.append(item.handle)
    return lines, sensitive, named


class TextSnapshotter:
    def __init__(self, redactor: Redactor):
        self.redactor = redactor
        self._seen: "OrderedDict[Hashable, OrderedDict[str, None]]" = OrderedDict()

    def forget(self, window_key: Hashable) -> None:
        self._seen.pop(window_key, None)

    def process(self, window_key: Hashable, items: List[WalkItem], doc_text: Optional[str]) -> SnapshotResult:
        lines, sensitive, named = classify(items, self.redactor)
        if doc_text:
            budget = DOC_CHARS
            for raw in doc_text.splitlines():
                if budget <= 0:
                    break
                line = _norm(raw[:budget])
                budget -= len(raw) + 1
                if line and _meaningful(line):
                    lines.append(self.redactor.redact(line))

        text_chars = sum(len(l) for l in lines)
        seen = self._seen.get(window_key)
        if seen is None:
            seen = OrderedDict()
            self._seen[window_key] = seen
            while len(self._seen) > MAX_WINDOWS:
                self._seen.popitem(last=False)
        else:
            self._seen.move_to_end(window_key)

        delta: List[str] = []
        size = 0
        snapshot_seen = set()
        for line in lines:
            if line in snapshot_seen:
                continue
            snapshot_seen.add(line)
            if line in seen:
                seen.move_to_end(line)
                continue
            encoded = len(line.encode("utf-8")) + 1
            if size + encoded > MAX_DELTA_BYTES:
                continue  # not marked as seen, so a later snapshot can still emit it
            seen[line] = None
            if len(seen) > MAX_SEEN_LINES:
                seen.popitem(last=False)
            size += encoded
            delta.append(line)
        return SnapshotResult(delta=delta, named_elements=named, text_chars=text_chars, sensitive=sensitive)
