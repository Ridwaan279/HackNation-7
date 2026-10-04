"""JSON-lines protocol between the sidecar and Electron's observer.ts.

stdout: one JSON object per line (events and replies), ASCII-only so the
Windows code page can never garble it. stdin: one command per line.
Shapes are defined in shared/contracts.ts.
"""
from __future__ import annotations

import json
import threading
import time
from typing import Any, Dict, Optional, Tuple

MODES = ("ambient", "session", "tutor", "paused")
CAPTURES = ("uia", "vision")
A11Y_CHOICES = ("yes", "later", "never")

# Which thread runs each command (see observer.py).
ROUTES = {
    "redact": "inline",  # pure function, answered by the stdin thread
    "mode": "fast",
    "set_capture": "fast",
    "reload_config": "fast",
    "a11y_ack": "fast",
    "tree": "slow",  # walks the UI tree
    "shot": "slow",  # takes a screenshot
}


class Emitter:
    """Thread-safe line writer. `pretty` prints a human-readable line instead (--print)."""

    def __init__(self, stream, pretty: bool = False):
        self._stream = stream
        self._pretty = pretty
        self._lock = threading.Lock()
        self.closed = False

    def emit(self, obj: Dict[str, Any]) -> None:
        line = format_pretty(obj) if self._pretty else json.dumps(obj, ensure_ascii=True, separators=(",", ":"))
        with self._lock:
            if self.closed:
                return
            try:
                self._stream.write(line + "\n")
                self._stream.flush()
            except (OSError, ValueError):  # parent went away / stream closed
                self.closed = True


def format_pretty(obj: Dict[str, Any]) -> str:
    t = obj.get("t")
    stamp = time.strftime("%H:%M:%S", time.localtime(t)) if isinstance(t, (int, float)) else "--:--:--"
    kind = obj.get("type") or ("reply" if "id" in obj else "?")
    rest = {k: v for k, v in obj.items() if k not in ("t", "type")}
    return f"{stamp} {kind:<12} {json.dumps(rest, ensure_ascii=False)}"


def reply_ok(cmd_id: int, **fields: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {"id": cmd_id, "ok": True}
    out.update(fields)
    return out


def reply_error(cmd_id: int, error: str) -> Dict[str, Any]:
    return {"id": cmd_id, "ok": False, "error": error}


def parse_command(line: str) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Return (command, None) when valid, (None, error_reply) when not.

    Lines without a usable integer id can't be answered: (None, None).
    """
    try:
        obj = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return None, None
    if not isinstance(obj, dict):
        return None, None
    cmd_id = obj.get("id")
    if not isinstance(cmd_id, int) or isinstance(cmd_id, bool):
        return None, None
    cmd = obj.get("cmd")
    if cmd not in ROUTES:
        return None, reply_error(cmd_id, f"unknown command: {cmd!r}")

    if cmd == "redact":
        if not isinstance(obj.get("text"), str):
            return None, reply_error(cmd_id, "redact needs a string 'text'")
    elif cmd == "tree":
        mx = obj.get("max", 300)
        if not isinstance(mx, int) or isinstance(mx, bool):
            return None, reply_error(cmd_id, "tree needs an integer 'max'")
        obj["max"] = max(1, min(mx, 2000))
    elif cmd == "mode":
        if obj.get("value") not in MODES:
            return None, reply_error(cmd_id, f"mode must be one of {MODES}")
    elif cmd == "set_capture":
        if not isinstance(obj.get("key"), str) or not obj["key"]:
            return None, reply_error(cmd_id, "set_capture needs a 'key'")
        if obj.get("value") not in CAPTURES:
            return None, reply_error(cmd_id, f"capture must be one of {CAPTURES}")
    elif cmd == "a11y_ack":
        if not isinstance(obj.get("key"), str) or not obj["key"]:
            return None, reply_error(cmd_id, "a11y_ack needs a 'key'")
        if obj.get("choice") not in A11Y_CHOICES:
            return None, reply_error(cmd_id, f"choice must be one of {A11Y_CHOICES}")
    return obj, None
