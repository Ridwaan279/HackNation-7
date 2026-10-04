"""Global mouse and keyboard hooks (pynput low-level hooks on Windows).

Windows silently removes a low-level hook whose callback is slow, so every
callback only builds a tiny HookEvent and hands it to `sink` (a queue put).
Privacy: the keyboard callback never looks at which character was typed.
It reports Enter / Tab / Esc / Ctrl+S / Ctrl+Enter by key identity and
everything else as a content-free "typing" tick.
"""
from __future__ import annotations

import time
from typing import Callable, Optional

from model import HookEvent

VK_S = 0x53


class Hooks:
    MOVE_EVERY = 0.1
    SCROLL_EVERY = 0.25

    def __init__(self, sink: Callable[[HookEvent], None], ctrl_down: Optional[Callable[[], bool]] = None):
        self.sink = sink
        self._ctrl_down = ctrl_down or (lambda: False)
        self._mouse = None
        self._keyboard = None
        self._key = None
        self._last_move = 0.0
        self._last_scroll = 0.0

    def start(self) -> None:
        from pynput import keyboard, mouse

        self._key = keyboard.Key
        self._mouse = mouse.Listener(on_move=self._on_move, on_click=self._on_click, on_scroll=self._on_scroll)
        self._keyboard = keyboard.Listener(on_press=self._on_press)
        for listener in (self._mouse, self._keyboard):
            listener.daemon = True
            listener.start()

    def stop(self) -> None:
        for listener in (self._mouse, self._keyboard):
            if listener is not None:
                try:
                    listener.stop()
                except Exception:
                    pass
        self._mouse = self._keyboard = None

    def restart(self) -> None:
        self.stop()
        self.start()

    # Callbacks accept *rest so they work with pynput 1.7 (no `injected` arg) and 1.8.
    # They must never raise: an exception stops the pynput listener.

    def _on_move(self, x, y, *rest) -> None:
        try:
            t = time.time()
            if t - self._last_move >= self.MOVE_EVERY:
                self._last_move = t
                self.sink(HookEvent("move", t, x=int(x), y=int(y)))
        except Exception:
            pass

    def _on_click(self, x, y, button, pressed, *rest) -> None:
        try:
            if not pressed:
                return
            name = getattr(button, "name", "")
            if name in ("left", "right", "middle"):
                self.sink(HookEvent("click", time.time(), x=int(x), y=int(y), button=name))
        except Exception:
            pass

    def _on_scroll(self, x, y, dx, dy, *rest) -> None:
        try:
            t = time.time()
            if t - self._last_scroll >= self.SCROLL_EVERY:
                self._last_scroll = t
                self.sink(HookEvent("scroll", t, x=int(x), y=int(y)))
        except Exception:
            pass

    def _on_press(self, key, *rest) -> None:
        try:
            t = time.time()
            k = self._key
            name = None
            if key == k.enter:
                name = "ctrl+enter" if self._ctrl_down() else "enter"
            elif key == k.tab:
                name = "tab"
            elif key == k.esc:
                name = "esc"
            elif getattr(key, "vk", None) == VK_S and self._ctrl_down():
                name = "ctrl+s"
            self.sink(HookEvent("key", t, key=name) if name else HookEvent("typing", t))
        except Exception:
            pass
