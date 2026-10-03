"""Observer engine: turns OS observations into the events in shared/contracts.ts.

The engine is platform-neutral and deterministic given a backend and a clock,
so tests drive it directly with FakeBackend. observer.py runs it on threads:

  fast thread  on_hook() + fast_tick()    clicks, keys, focus/commits, context (2 Hz)
  slow thread  slow_tick() + tree/shot    text snapshots, health, periodic screenshots, displays
  stdin thread execute(redact)            pure, answered immediately

Privacy order everywhere: privacy gate -> redaction -> emit. Before any read
or capture that happens after the context was decided, the context is
re-validated (_still_allowed), so a tab that just navigated to a bank is
never read.
"""
from __future__ import annotations

import sys
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

import shots
from commit import TRACKED_TYPES, Commit, CommitTracker
from config import ConfigStore, iso_now, parse_iso
from health import HealthTracker
from model import Backend, ElementInfo, HookEvent, MonitorInfo, Rect, WindowInfo
from privacy import Decision, PrivacyGate, parse_url
from protocol import reply_error, reply_ok
from redact import MaskOptions, Redactor, looks_like_password_field
from scaling import ScalingTracker, rect_contains, rect_ok
from textsnap import TextSnapshotter, classify

VERSION = "0.1.0"
MAX_VALUE_CHARS = 1000
UWP_HOST = "applicationframehost.exe"


@dataclass(frozen=True)
class Ctx:
    win: WindowInfo
    decision: Decision
    capture: str  # 'uia' | 'vision'
    version: int
    since: float


def _truncate(s: str, n: int = MAX_VALUE_CHARS) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


class Engine:
    CONTEXT_EVERY = 0.5
    FOCUS_EVERY = 0.3
    WATCHDOG_EVERY = 2.0
    DISPLAYS_EVERY = 5.0
    JANITOR_EVERY = 300.0
    TEXT_SETTLE_S = 1.0
    TEXT_EVERY = 15.0
    WEB_CHECK_EVERY = 3.0
    WEB_RECHECK_OK_EVERY = 30.0
    HEALTH_EVERY = 2.0
    HEARTBEAT_EVERY = 5.0
    VISION_HEARTBEAT_EVERY = 2.0
    AMBIENT_SHOT_EVERY = 60.0
    VISION_AMBIENT_EVERY = 30.0
    ACTIVITY_THROTTLE = 0.5
    ACTIVE_WINDOW_S = 5.0
    MINOR_EMIT_THROTTLE = 1.0
    CLICK_STICKY_S = 0.5
    A11Y_PROMPT_EVERY_S = 24 * 3600
    WALK_MAX_DEPTH = 10
    WALK_MAX_ELEMENTS = 300
    WALK_BUDGET_S = 1.5
    TREE_BUDGET_S = 1.5
    SENSITIVE_MAX_AGE_S = 3.0  # screenshots need a sensitive-field map at most this old
    QUICK_SCAN_ELEMENTS = 200
    QUICK_SCAN_BUDGET_S = 0.4
    SLOW_FAST_STEP_S = 2.0  # a fast-thread step this slow usually means a hung app
    SLOW_SLOW_STEP_S = 5.0

    def __init__(self, backend: Backend, emitter, config: ConfigStore, data_dir: Path,
                 own_pids: Iterable[int] = (), mode: str = "ambient", clock: Callable[[], float] = time.time):
        self.backend = backend
        self.emitter = emitter
        self.config = config
        self.data_dir = Path(data_dir)
        self.clock = clock
        self.mode = mode
        self.gate = PrivacyGate(config, own_pids)
        self.redactor = Redactor(MaskOptions.from_config(config.privacy.get("mask")))
        self.texts = TextSnapshotter(self.redactor)
        self.commits = CommitTracker()
        self.health = HealthTracker()
        self.scaling = ScalingTracker()
        for key, entry in config.app_modes.items():
            factor = entry.get("rect_scale")
            if isinstance(factor, (int, float)) and not isinstance(factor, bool) and factor > 0:
                self.scaling.set_correction(key, float(factor), entry.get("rect_anchor", "screen"))

        self.ctx: Optional[Ctx] = None
        self._ctx_sig: Optional[tuple] = None
        self._version = 0
        self._last_emitted: Optional[tuple] = None
        self._last_minor: Tuple[Optional[str], Optional[Rect], float] = (None, None, 0.0)
        self._click_sticky: Tuple[int, float] = (0, 0.0)

        now = clock()
        self._next: Dict[str, float] = {"context": 0.0, "focus": 0.0, "watchdog": now + self.WATCHDOG_EVERY,
                                        "displays": now + self.DISPLAYS_EVERY, "janitor": now + self.JANITOR_EVERY}
        self._activity_t: Dict[str, float] = {}
        self.last_input_t = 0.0
        self._last_hook_t = now
        self._last_hook_restart = 0.0
        self._silent_restarts = 0
        self._last_fast_tick = now

        self._monitors: List[MonitorInfo] = []
        self._monitor_sig: Optional[tuple] = None
        self._sensitive: Dict[tuple, List[Rect]] = {}  # (hwnd, key) -> rects relative to the window origin
        self._sensitive_t: Dict[tuple, float] = {}  # when that map was last refreshed
        self._focus_sensitive: Optional[Rect] = None
        self._sig: Dict[int, Any] = {}
        self._last_shot_t: Dict[int, float] = {}
        self._text_state: Dict[tuple, Tuple[float, str]] = {}
        self._web_next: Dict[tuple, float] = {}
        self._health_next = 0.0
        self._last_url: Dict[int, str] = {}  # hwnd -> last address-bar value that was a URL
        self._last_slow_warning = -1e9  # time.monotonic()

    # ------------------------------------------------------------------ output

    def _emit(self, obj: Dict[str, Any]) -> None:
        if "t" not in obj:
            obj = {"type": obj.get("type"), "t": self.clock(), **{k: v for k, v in obj.items() if k != "type"}}
        self.emitter.emit(obj)

    def start(self) -> None:
        awareness = self.backend.dpi_awareness()
        self._emit({"type": "ready", "t": self.clock(), "version": VERSION, "platform": sys.platform,
                    "backend": self.backend.name, "dpi_awareness": awareness})
        if self.backend.name == "windows" and awareness != "per_monitor":
            self._emit({"type": "warning", "t": self.clock(), "code": "dpi_unaware",
                        "detail": f"process DPI awareness is {awareness}; coordinates may be scaled"})
        self._emit_displays(force=True)
        shots.janitor(self.data_dir, self.clock())

    def _emit_displays(self, force: bool = False) -> None:
        try:
            mons = self.backend.monitors()
        except Exception:
            return
        sig = tuple(mons)
        if force or sig != self._monitor_sig:
            self._monitor_sig = sig
            self._monitors = mons
            self._emit({"type": "displays", "t": self.clock(), "monitors": [
                {"id": m.id, "rect_px": list(m.rect), "work_px": list(m.work), "dpi": m.dpi,
                 "scale": m.scale, "primary": m.primary} for m in mons]})

    # ----------------------------------------------------------------- context

    def _decide(self, win: WindowInfo) -> Decision:
        if self.mode == "paused":
            return Decision(True, "paused", win.process.lower())
        url = None
        private = False
        if self.gate.is_browser(win) and win.pid not in self.gate.own_pids:
            url = self.backend.browser_url(win)
            if url is not None:
                if parse_url(url)[1] is not None:
                    self._last_url[win.hwnd] = url
                elif win.hwnd in self._last_url:
                    # The user is typing a search in the address bar: the page is still the last URL.
                    url = self._last_url[win.hwnd]
            if self.config.privacy.get("skip", {}).get("private_windows", True):
                private = self.backend.private_window(win, self.gate.private_markers())
        return self.gate.decide(win, url, private, self.mode)

    def _still_allowed(self, ctx: Ctx) -> bool:
        """Re-check right before reading or capturing: same window, same key, still allowed."""
        if self.mode == "paused":
            return False
        fg = self.backend.foreground()
        if fg is None or fg.hwnd != ctx.win.hwnd:
            return False
        d = self._decide(fg)
        return not d.blocked and d.key == ctx.decision.key

    def _refresh_context(self, now: float, win: Optional[WindowInfo] = None) -> Optional[Ctx]:
        if win is None:
            win = self.backend.foreground()
            sticky_hwnd, sticky_until = self._click_sticky
            if win is not None and now < sticky_until and win.hwnd != sticky_hwnd:
                return self.ctx  # the clicked window is still becoming the foreground
        if win is None or win.minimized:
            return self.ctx
        decision = self._decide(win)
        capture = "uia"
        if not decision.blocked:
            capture = self.config.app_mode(decision.key).get("capture", "uia")
            if capture not in ("uia", "vision"):
                capture = "uia"
        sig = (win.hwnd, decision.blocked, decision.reason, None if decision.blocked else decision.key,
               capture, win.monitor, win.dpi_awareness, win.window_dpi, win.monitor_scale)
        old = self.ctx
        if sig != self._ctx_sig:
            if old is not None and not old.decision.blocked and old.capture == "uia":
                # Leaving a field in the previous context: commit it first.
                self._emit_commits(self.commits.observe(None, now), old)
            self._focus_sensitive = None
            self._version += 1
            self.ctx = Ctx(win, decision, capture, self._version, now)
            self._ctx_sig = sig
            self._emit_context(now, major=True)
            if not decision.blocked and self.gate.is_remote_session(win):
                self.health.note_remote(decision.key)
                self._evaluate_health(decision.key, now)
        else:
            self.ctx = replace(old, win=win) if old else Ctx(win, decision, capture, self._version, now)
            if not decision.blocked:
                last_title, last_rect, last_t = self._last_minor
                if (win.title != last_title or win.rect != last_rect) and now - last_t >= self.MINOR_EMIT_THROTTLE:
                    self._emit_context(now, major=False)
        return self.ctx

    def _emit_context(self, now: float, major: bool) -> None:
        ctx = self.ctx
        if ctx is None:
            return
        if ctx.decision.blocked:
            tag = ("blocked", ctx.decision.reason)
            if self._last_emitted != tag:
                self._emit({"type": "blocked", "t": now, "reason": ctx.decision.reason})
                self._last_emitted = tag
            return
        w = ctx.win
        self._emit({"type": "context", "t": now, "app": w.process, "key": ctx.decision.key,
                    "title": self.redactor.redact(w.title), "blocked": False, "hwnd": w.hwnd,
                    "monitor": w.monitor, "window_rect": list(w.rect), "dpi_awareness": w.dpi_awareness,
                    "window_dpi": w.window_dpi, "monitor_scale": w.monitor_scale, "capture": ctx.capture})
        self._last_emitted = ("context", ctx.decision.key)
        self._last_minor = (w.title, w.rect, now)

    def _allowed_ctx(self) -> Optional[Ctx]:
        ctx = self.ctx
        return ctx if ctx is not None and not ctx.decision.blocked else None

    def _guard(self, what: str, started: float, limit: float) -> None:
        """Report (at most once a minute) when one step took long enough to suggest a hung app."""
        now = time.monotonic()
        took = now - started
        if took > limit and now - self._last_slow_warning > 60.0:
            self._last_slow_warning = now
            self._emit({"type": "warning", "t": self.clock(), "code": "uia_timeout",
                        "detail": f"{what} took {took:.1f} s; the app under the cursor may not be responding"})

    # ------------------------------------------------------------------- hooks

    def on_hook(self, ev: HookEvent) -> None:
        started = time.monotonic()
        try:
            self._on_hook(ev)
        finally:
            self._guard(f"handling a {ev.kind}", started, self.SLOW_FAST_STEP_S)

    def _on_hook(self, ev: HookEvent) -> None:
        self._last_hook_t = self.clock()
        self._silent_restarts = 0
        self.last_input_t = ev.t
        if self.mode == "paused":
            return
        if ev.kind == "click":
            self._on_click(ev)
            return
        ctx = self._allowed_ctx()
        if ctx is None:
            return
        if ev.kind == "key":
            self._emit({"type": "key", "t": ev.t, "key": ev.key})
            self._activity("typing", ev.t)
            if ctx.capture == "uia" and ev.key in ("enter", "tab", "ctrl+s", "ctrl+enter"):
                self._emit_commits(self.commits.flush_final(self._focused(ctx), ev.t), ctx)
        elif ev.kind == "typing":
            self._activity("typing", ev.t)
        elif ev.kind == "scroll":
            self._activity("scroll", ev.t)
        elif ev.kind == "move":
            self._activity("mouse", ev.t)

    def _activity(self, kind: str, t: float) -> None:
        if t - self._activity_t.get(kind, -1e9) >= self.ACTIVITY_THROTTLE:
            self._activity_t[kind] = t
            self._emit({"type": "activity", "t": t, "kind": kind})

    def _on_click(self, ev: HookEvent) -> None:
        now = ev.t
        win = self.backend.window_at(ev.x, ev.y)
        if win is None or win.pid in self.gate.own_pids:
            return  # a click on our own UI (the ghost) is not a step
        self._click_sticky = (win.hwnd, now + self.CLICK_STICKY_S)
        ctx = self._refresh_context(now, win=win)  # emits context first if the click switched windows
        if ctx is None or ctx.decision.blocked or ctx.win.hwnd != win.hwnd:
            return
        key = ctx.decision.key
        vision = ctx.capture == "vision"
        keep_shot = self.mode == "session"
        tutor_vision_shot = self.mode == "tutor" and vision

        img, region = None, None
        if keep_shot or tutor_vision_shot:
            region = self._capture_region(win)
            img = self.backend.capture(region) if region else None

        target = None
        box: Optional[Rect] = None
        extra_sensitive: List[Rect] = []
        if not vision:
            el = self.backend.element_at(ev.x, ev.y, win)
            if el is not None and el.pid in self.gate.own_pids:
                el = None
            if el is None:
                self.health.note_click(key, False)
            else:
                rect, trusted = el.rect, rect_contains(el.rect, ev.x, ev.y)
                res = self.scaling.check(key, ev.x, ev.y, el.rect, win.monitor_scale, win.monitor_rect[:2])
                if res is not None:
                    rect, trusted = res.rect, res.trusted
                    if res.event:
                        self._on_scaling_event(res.event, now)
                self.health.note_click(key, self._resolved(el, win))
                name = el.name
                if el.control_type == "TabItem" and self.gate.is_browser(win):
                    name = "browser tab"  # its title could be a site the privacy rules skip
                target = {"name": self.redactor.redact(name), "control_type": el.control_type,
                          "automation_id": el.automation_id, "rect": list(rect) if rect else [0, 0, 0, 0],
                          "rect_trusted": bool(trusted and rect_ok(rect))}
                box = rect if rect_ok(rect) else None
                if box and (el.is_password or looks_like_password_field(el.name)):
                    extra_sensitive.append(box)
            self._evaluate_health(key, now)

        shot_rel, meta = None, None
        if img is not None and region is not None:
            self._sig[win.hwnd] = shots.signature(img)
            self._last_shot_t[win.hwnd] = now
            if not vision:
                self._ensure_sensitive(ctx, now)  # pixels were taken at mouse-down; this only finds what to blur
            shot_rel, meta = self._finish_shot(img, region, win, ctx, now, click=(ev.x, ev.y), box=box,
                                               extra_sensitive=extra_sensitive, ephemeral=tutor_vision_shot,
                                               auto_blur=not vision, max_edge=shots.MAX_EDGE)
        self._emit({"type": "click", "t": now, "x": ev.x, "y": ev.y, "button": ev.button, "target": target,
                    "shot": shot_rel if keep_shot else None, "shot_meta": meta if keep_shot else None})
        if tutor_vision_shot and shot_rel:
            self._emit({"type": "shot", "t": now, "key": key, "path": shot_rel, "reason": "vision_mode",
                        "meta": meta, "ephemeral": True})

    @staticmethod
    def _resolved(el: ElementInfo, win: WindowInfo) -> bool:
        if not el.name.strip():
            return False
        if el.control_type in ("Pane", "Window", "Document", "Custom", "Group") and rect_ok(el.rect) and rect_ok(win.rect):
            area = (el.rect[2] - el.rect[0]) * (el.rect[3] - el.rect[1])
            warea = (win.rect[2] - win.rect[0]) * (win.rect[3] - win.rect[1])
            if area > 0.5 * warea:
                return False
        return True

    # ------------------------------------------------------------------ focus

    def _focused(self, ctx: Ctx):
        try:
            f = self.backend.focused(TRACKED_TYPES)
        except Exception:
            return None
        if f is None or f.pid in self.gate.own_pids:
            return None
        if f.pid != ctx.win.pid and ctx.win.process.lower() != UWP_HOST:
            return None
        return f

    def _poll_focus(self, now: float, ctx: Ctx) -> None:
        f = self._focused(ctx)
        if f is not None and (f.is_password or looks_like_password_field(f.name)) and rect_ok(f.rect):
            self._focus_sensitive = f.rect
        else:
            self._focus_sensitive = None
        self._emit_commits(self.commits.observe(f, now), ctx)

    def _emit_commits(self, commits: List[Commit], ctx: Ctx) -> None:
        for c in commits:
            old, m1 = self.redactor.redact_with_flag(c.old[:20000])
            new, m2 = self.redactor.redact_with_flag(c.new[:20000])
            rect = self.scaling.correct(ctx.decision.key, c.rect, ctx.win.monitor_rect[:2])
            if (m1 or m2) and rect_ok(rect):
                self._remember_sensitive(ctx, [rect])
            self._emit({"type": "commit", "t": c.t, "field": self.redactor.redact(c.field),
                        "old": _truncate(old), "new": _truncate(new), "rect": list(rect) if rect_ok(rect) else None,
                        "masked": bool(m1 or m2), "source": "uia", "final": c.final})

    def _remember_sensitive(self, ctx: Ctx, rects: List[Rect]) -> None:
        wk = (ctx.win.hwnd, ctx.decision.key)
        ox, oy = ctx.win.rect[0], ctx.win.rect[1]
        rel = [(r[0] - ox, r[1] - oy, r[2] - ox, r[3] - oy) for r in rects if rect_ok(r)]
        merged = (self._sensitive.get(wk, []) + rel)[-100:]
        self._sensitive[wk] = merged

    # -------------------------------------------------------------- fast tick

    def fast_tick(self) -> None:
        started = time.monotonic()
        try:
            self._fast_tick()
        finally:
            self._guard("reading the focused field", started, self.SLOW_FAST_STEP_S)

    def _fast_tick(self) -> None:
        now = self.clock()
        dt = min(max(0.0, now - self._last_fast_tick), 1.0)
        self._last_fast_tick = now
        if now >= self._next["watchdog"]:
            self._next["watchdog"] = now + self.WATCHDOG_EVERY
            self._watchdog(now)
        if self.mode == "paused":
            return
        if now >= self._next["context"]:
            self._next["context"] = now + self.CONTEXT_EVERY
            self._refresh_context(now)
        ctx = self._allowed_ctx()
        if ctx is None:
            return
        if now - self.last_input_t <= self.ACTIVE_WINDOW_S:
            self.health.note_active(ctx.decision.key, dt)
        if ctx.capture == "uia" and now >= self._next["focus"]:
            self._next["focus"] = now + self.FOCUS_EVERY
            self._poll_focus(now, ctx)

    def _watchdog(self, now: float) -> None:
        idle = self.backend.input_idle_s()
        if idle is None or idle >= 2.0:
            return
        if now - self._last_hook_t > 5.0 and now - self._last_hook_restart > 60.0 and self._silent_restarts < 3:
            self.backend.restart_hooks()
            self._last_hook_restart = now
            self._silent_restarts += 1
            self._emit({"type": "warning", "t": now, "code": "hook_restarted",
                        "detail": "input hooks went silent while the user was active; reinstalled"})

    # -------------------------------------------------------------- slow tick

    def slow_tick(self) -> None:
        started = time.monotonic()
        try:
            self._slow_tick()
        finally:
            self._guard("reading the window's text", started, self.SLOW_SLOW_STEP_S)

    def _slow_tick(self) -> None:
        now = self.clock()
        if now >= self._next["janitor"]:
            self._next["janitor"] = now + self.JANITOR_EVERY
            shots.janitor(self.data_dir, now)
        if now >= self._next["displays"]:
            self._next["displays"] = now + self.DISPLAYS_EVERY
            self._emit_displays()
        if self.mode == "paused":
            return
        ctx = self._allowed_ctx()
        if ctx is None:
            return
        if ctx.capture == "uia":
            self._maybe_text_snapshot(now, ctx)
            self._maybe_web_check(now, ctx)
            if now >= self._health_next:  # active time alone can complete a verdict
                self._health_next = now + self.HEALTH_EVERY
                self._evaluate_health(ctx.decision.key, now)
        self._maybe_periodic_shot(now, ctx)

    def _maybe_text_snapshot(self, now: float, ctx: Ctx) -> None:
        win = ctx.win
        wk = (win.hwnd, ctx.decision.key)
        last = self._text_state.get(wk)
        if last is None:
            due = now - ctx.since >= self.TEXT_SETTLE_S
        elif last[1] != win.title:
            due = True
        else:
            due = now - last[0] >= self.TEXT_EVERY and now - self.last_input_t <= self.TEXT_EVERY
        if not due or not self._still_allowed(ctx):
            return
        self._text_state[wk] = (now, win.title)
        try:
            res = self.backend.walk_text(win, self.WALK_MAX_DEPTH, self.WALK_MAX_ELEMENTS, self.WALK_BUDGET_S,
                                         content_only=self.gate.is_browser(win))
        except Exception:
            res = None
        if res is None:
            return
        current = self.ctx
        if current is None or current.version != ctx.version or not self._still_allowed(ctx):
            return  # the window changed while we were reading it: discard
        snap = self.texts.process(wk, res.items, res.doc_text)
        rects = []
        for handle in snap.sensitive[:50]:
            try:
                r = self.backend.rect_of(handle)
            except Exception:
                r = None
            if rect_ok(r):
                rects.append(self.scaling.correct(ctx.decision.key, r, win.monitor_rect[:2]))
        ox, oy = win.rect[0], win.rect[1]
        self._sensitive[wk] = [(r[0] - ox, r[1] - oy, r[2] - ox, r[3] - oy) for r in rects]
        self._sensitive_t[wk] = now
        self.health.note_snapshot(ctx.decision.key, snap.named_elements, snap.text_chars)
        self._evaluate_health(ctx.decision.key, now)
        if snap.delta:
            self._emit({"type": "text", "t": now, "key": ctx.decision.key,
                        "title": self.redactor.redact(win.title), "delta": snap.delta})

    def _maybe_web_check(self, now: float, ctx: Ctx) -> None:
        win = ctx.win
        if win.class_name != "Chrome_WidgetWin_1":
            return
        if ctx.decision.domain and ctx.decision.domain in {h.lower() for h in self.config.skiplists.get("browser_internal_allowed_hosts", [])}:
            return  # a blank new tab legitimately has an empty document
        wk = (win.hwnd, ctx.decision.key)
        if now < self._web_next.get(wk, 0.0) or not self._still_allowed(ctx):
            return
        try:
            empty = self.backend.web_document_empty(win)
        except Exception:
            empty = None
        self._web_next[wk] = now + (self.WEB_CHECK_EVERY if empty else self.WEB_RECHECK_OK_EVERY)
        self.health.note_web_document(ctx.decision.key, empty, now)
        self._evaluate_health(ctx.decision.key, now)

    def _maybe_periodic_shot(self, now: float, ctx: Ctx) -> None:
        win = ctx.win
        vision = ctx.capture == "vision"
        width = None
        max_edge = shots.MAX_EDGE
        if self.mode in ("session", "tutor"):
            every = self.VISION_HEARTBEAT_EVERY if vision else self.HEARTBEAT_EVERY
            reason = "vision_mode" if vision else "heartbeat"
            ephemeral = self.mode == "tutor"
        elif self.mode == "ambient":
            ephemeral = True
            if vision:
                every, reason = self.VISION_AMBIENT_EVERY, "vision_mode"
            elif self.config.privacy.get("ambient_screenshots", True):
                every, reason = self.AMBIENT_SHOT_EVERY, "ambient"
                width, max_edge = shots.AMBIENT_WIDTH, None
            else:
                return
        else:
            return
        if now - self._last_shot_t.get(win.hwnd, -1e9) < every:
            return
        self._last_shot_t[win.hwnd] = now
        if not self._still_allowed(ctx):
            return
        region = self._capture_region(win)
        img = self.backend.capture(region) if region else None
        if img is None:
            return
        sig = shots.signature(img)
        if not shots.changed(self._sig.get(win.hwnd), sig):
            return
        self._sig[win.hwnd] = sig
        if not vision:
            self._ensure_sensitive(ctx, now)
        rel, meta = self._finish_shot(img, region, win, ctx, now, click=None, box=None, extra_sensitive=[],
                                      ephemeral=ephemeral, auto_blur=not vision, max_edge=max_edge, width=width)
        self._emit({"type": "shot", "t": now, "key": ctx.decision.key, "path": rel, "reason": reason,
                    "meta": meta, "ephemeral": ephemeral})

    # ------------------------------------------------------------ screenshots

    def _capture_region(self, win: WindowInfo) -> Optional[Rect]:
        if not rect_ok(win.rect):
            return None
        base = shots.union([win.rect, win.popup_rect]) if rect_ok(win.popup_rect) else win.rect
        virtual = shots.union(m.rect for m in self._monitors)
        return shots.intersect(base, virtual) if virtual else base

    def _ensure_sensitive(self, ctx: Ctx, now: float) -> None:
        """Make sure we know where this window's secrets are before saving a screenshot of it."""
        wk = (ctx.win.hwnd, ctx.decision.key)
        if now - self._sensitive_t.get(wk, -1e9) <= self.SENSITIVE_MAX_AGE_S:
            return
        self._sensitive_t[wk] = now
        try:
            res = self.backend.walk_text(ctx.win, self.WALK_MAX_DEPTH, self.QUICK_SCAN_ELEMENTS, self.QUICK_SCAN_BUDGET_S,
                                         content_only=self.gate.is_browser(ctx.win))
        except Exception:
            res = None
        if res is None:
            return
        _, handles, _ = classify(res.items, self.redactor)
        rects = []
        for handle in handles[:50]:
            try:
                r = self.backend.rect_of(handle)
            except Exception:
                r = None
            if rect_ok(r):
                rects.append(self.scaling.correct(ctx.decision.key, r, ctx.win.monitor_rect[:2]))
        ox, oy = ctx.win.rect[0], ctx.win.rect[1]
        known = self._sensitive.get(wk, [])
        fresh = [(r[0] - ox, r[1] - oy, r[2] - ox, r[3] - oy) for r in rects]
        self._sensitive[wk] = (fresh + [r for r in known if r not in fresh])[:100]

    def _finish_shot(self, img, region: Rect, win: WindowInfo, ctx: Ctx, now: float, click, box,
                     extra_sensitive: List[Rect], ephemeral: bool, auto_blur: bool,
                     max_edge: Optional[int] = None, width: Optional[int] = None):
        origin = (region[0], region[1])
        if auto_blur:
            ox, oy = win.rect[0], win.rect[1]
            rel = self._sensitive.get((win.hwnd, ctx.decision.key), [])
            rects = [(r[0] + ox, r[1] + oy, r[2] + ox, r[3] + oy) for r in rel] + list(extra_sensitive)
            if self._focus_sensitive:
                rects.append(self._focus_sensitive)
            shots.blur_rects(img, origin, rects)
        if click or box:
            shots.annotate(img, origin, click, box)
        out, scale = shots.downscale(img, max_edge=max_edge, width=width)
        rel_path = shots.save_jpeg(out, self.data_dir, now, ephemeral)
        meta = shots.shot_meta(origin, (region[2] - region[0], region[3] - region[1]), scale, win.monitor, auto_blur)
        return rel_path, meta

    # ------------------------------------------------------- health & scaling

    def _evaluate_health(self, key: str, now: float) -> None:
        ev = self.health.evaluate(key)
        if ev is None:
            return
        entry = self.config.app_mode(key)
        prompt = False
        if ev["status"] == "blind" and entry.get("capture", "uia") == "uia" and not entry.get("never_ask"):
            last = parse_iso(entry.get("a11y_prompted_at"))
            if last is None or now - last >= self.A11Y_PROMPT_EVERY_S:
                prompt = True
                self.config.update_app_mode(key, a11y_prompted_at=iso_now(now))
        self._emit({"type": "a11y_health", "t": now, **ev, "prompt": prompt})

    def _on_scaling_event(self, ev: dict, now: float) -> None:
        key = ev["key"]
        if ev["status"] == "corrected":
            self.config.update_app_mode(key, rect_scale=ev["rect_scale"], rect_anchor=ev["rect_anchor"])
        else:
            self.config.update_app_mode(key, rect_scale=None, rect_anchor=None)
        self._emit({"type": "app_scaling", "t": now, **ev})

    # ---------------------------------------------------------------- commands

    def execute(self, cmd: Dict[str, Any]) -> Dict[str, Any]:
        cid = cmd["id"]
        try:
            name = cmd["cmd"]
            if name == "redact":
                return reply_ok(cid, text=self.redactor.redact(cmd["text"]))
            if name == "mode":
                self._set_mode(cmd["value"])
                return reply_ok(cid)
            if name == "set_capture":
                self._set_capture(cmd["key"], cmd["value"])
                return reply_ok(cid)
            if name == "reload_config":
                self._reload()
                return reply_ok(cid)
            if name == "a11y_ack":
                self._a11y_ack(cmd["key"], cmd["choice"])
                return reply_ok(cid)
            if name == "tree":
                return self._tree(cid, int(cmd.get("max", 300)))
            if name == "shot":
                return self._shot(cid)
            return reply_error(cid, f"unknown command: {name!r}")
        except Exception as ex:  # never let one command kill the thread
            return reply_error(cid, f"{type(ex).__name__}: {ex}")

    def _force_context(self) -> None:
        self._ctx_sig = None
        self._last_emitted = None
        self._next["context"] = 0.0

    def _set_mode(self, value: str) -> None:
        if value == self.mode:
            return
        self.mode = value
        if value == "paused":
            self.commits.reset()  # drop un-committed typing; emit nothing about it
            self._focus_sensitive = None
            self.ctx = None
            self._ctx_sig = None
            self._emit({"type": "blocked", "t": self.clock(), "reason": "paused"})
            self._last_emitted = ("blocked", "paused")
        else:
            self._force_context()

    def _set_capture(self, key: str, value: str) -> None:
        self.config.update_app_mode(key, capture=value)
        ctx = self.ctx
        if ctx is not None and ctx.decision.key == key:
            if value == "vision":
                self.commits.reset()
            self._force_context()

    def _reload(self) -> None:
        self.config.load()
        self.redactor = Redactor(MaskOptions.from_config(self.config.privacy.get("mask")))
        self.texts.redactor = self.redactor
        self._force_context()

    def _a11y_ack(self, key: str, choice: str) -> None:
        stamp = iso_now(self.clock())
        if choice == "yes":
            self.config.update_app_mode(key, capture="vision", a11y_prompted_at=stamp)
        elif choice == "later":
            self.config.update_app_mode(key, a11y_prompted_at=stamp)
        elif choice == "never":
            self.config.update_app_mode(key, never_ask=True, a11y_prompted_at=stamp)
            self.config.block_key(key)
        self._force_context()

    def _tree(self, cid: int, max_count: int) -> Dict[str, Any]:
        ctx = self._allowed_ctx()
        if ctx is None or not self._still_allowed(ctx):
            return reply_error(cid, "blocked")
        if ctx.capture == "vision":
            return reply_ok(cid, controls=[])
        els = self.backend.tree(ctx.win, max_count, self.TREE_BUDGET_S, content_only=self.gate.is_browser(ctx.win))
        controls = []
        for el in els:
            rect = self.scaling.correct(ctx.decision.key, el.rect, ctx.win.monitor_rect[:2])
            if not rect_ok(rect) or not el.name.strip():
                continue
            controls.append({"name": self.redactor.redact(el.name), "control_type": el.control_type,
                             "automation_id": el.automation_id, "rect": list(rect)})
            if len(controls) >= max_count:
                break
        return reply_ok(cid, controls=controls)

    def _shot(self, cid: int) -> Dict[str, Any]:
        ctx = self._allowed_ctx()
        if ctx is None or not self._still_allowed(ctx):
            return reply_error(cid, "blocked")
        region = self._capture_region(ctx.win)
        img = self.backend.capture(region) if region else None
        if img is None:
            return reply_error(cid, "capture failed")
        now = self.clock()
        if ctx.capture == "uia":
            self._ensure_sensitive(ctx, now)
        rel, meta = self._finish_shot(img, region, ctx.win, ctx, now, click=None, box=None, extra_sensitive=[],
                                      ephemeral=True, auto_blur=ctx.capture == "uia", max_edge=shots.MAX_EDGE)
        return reply_ok(cid, path=rel, meta=meta)
