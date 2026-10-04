"""Plain data types shared by the engine and the backends.

Rects are (left, top, right, bottom) tuples in PHYSICAL screen pixels.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, ContextManager, List, Optional, Protocol, Tuple

Rect = Tuple[int, int, int, int]


@dataclass(frozen=True)
class WindowInfo:
    hwnd: int
    pid: int
    process: str  # exe name as on disk, e.g. "EXCEL.EXE"
    title: str
    class_name: str
    rect: Rect
    monitor: int
    monitor_rect: Rect
    monitor_scale: float
    window_dpi: int
    dpi_awareness: str  # 'unaware' | 'system' | 'per_monitor' | 'unknown'
    minimized: bool = False
    # Owned popup (dropdown, menu, dialog) the user is interacting with. The context
    # (privacy decision, app key) is always the visible owner window; screenshots
    # cover owner + popup.
    popup_rect: Optional[Rect] = None


@dataclass(frozen=True)
class MonitorInfo:
    id: int
    rect: Rect
    work: Rect
    dpi: int
    scale: float
    primary: bool


@dataclass
class ElementInfo:
    name: str
    control_type: str  # 'Button', 'Edit', ... (no "Control" suffix)
    automation_id: str
    rect: Optional[Rect]
    is_password: bool
    pid: int
    class_name: str = ""
    value: Optional[str] = None  # field value (tree only); never set for password-like fields


@dataclass
class FocusInfo:
    key: tuple  # identity of the element, stable while it keeps focus
    name: str
    control_type: str
    automation_id: str
    value: Optional[str]  # None for password fields and controls without a value
    is_password: bool
    rect: Optional[Rect]
    pid: int


@dataclass
class WalkItem:
    control_type: str
    name: str
    value: Optional[str]
    is_password: bool
    handle: Any = None  # backend-specific; lets the engine ask for the rect later


@dataclass
class WalkResult:
    items: List[WalkItem] = field(default_factory=list)
    visited: int = 0
    truncated: bool = False
    doc_text: Optional[str] = None


@dataclass
class HookEvent:
    kind: str  # 'click' | 'release' | 'key' | 'typing' | 'scroll' | 'move'
    t: float
    x: int = 0
    y: int = 0
    button: str = ""
    key: str = ""  # for kind == 'key': 'enter' | 'tab' | 'esc' | 'ctrl+s' | 'ctrl+enter'


class Backend(Protocol):
    """What the engine needs from the OS. WindowsBackend and FakeBackend implement it."""

    name: str  # 'windows' | 'fake'

    def dpi_awareness(self) -> str: ...
    def monitors(self) -> List[MonitorInfo]: ...
    def foreground(self) -> Optional[WindowInfo]: ...
    def window_at(self, x: int, y: int) -> Optional[WindowInfo]: ...
    def browser_url(self, win: WindowInfo) -> Optional[str]: ...
    def private_window(self, win: WindowInfo, markers: List[str]) -> bool: ...
    def element_at(self, x: int, y: int, win: WindowInfo) -> Optional[ElementInfo]: ...
    def selection_at(self, x: int, y: int, win: WindowInfo) -> Optional[str]: ...  # highlighted text, raw (engine masks it)
    def focused(self, tracked_types: frozenset) -> Optional[FocusInfo]: ...
    def walk_text(self, win: WindowInfo, max_depth: int, max_elements: int, budget_s: float,
                  content_only: bool = False) -> Optional[WalkResult]: ...  # content_only: browsers (page only)
    def rect_of(self, handle: Any) -> Optional[Rect]: ...
    def web_document_empty(self, win: WindowInfo) -> Optional[bool]: ...
    def tree(self, win: WindowInfo, max_count: int, budget_s: float, content_only: bool = False) -> List[ElementInfo]: ...
    def capture(self, rect: Rect) -> Any: ...  # PIL.Image.Image or None
    def input_idle_s(self) -> Optional[float]: ...
    def start_hooks(self, sink: Callable[[HookEvent], None]) -> None: ...
    def restart_hooks(self) -> None: ...
    def stop(self) -> None: ...
    def thread_init(self) -> ContextManager: ...
