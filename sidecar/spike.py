#!/usr/bin/env python3
"""Phase 1 spike (Windows): checks every OS capability the observer relies on.

    cd sidecar
    pip install -r requirements.txt
    python spike.py

Follow the prompts (about 2 minutes, with MiniERP open in Edge) and paste the
summary into docs/agents/a.md. It exercises the same adapter code the
observer uses (display.py, winapi.py, uia.py, hooks.py).
"""
import sys

sys.coinit_flags = 0  # same COM setup as observer.py

import os  # noqa: E402
import queue  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import display  # noqa: E402

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}", flush=True)


def timed(fn):
    t0 = time.perf_counter()
    value = fn()
    return value, (time.perf_counter() - t0) * 1000


def wait_for(q, kinds, seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            ev = q.get(timeout=0.2)
        except queue.Empty:
            continue
        if ev.kind in kinds:
            return ev
    return None


def countdown(msg, seconds):
    print(f"\n>>> {msg}", flush=True)
    for i in range(seconds, 0, -1):
        print(f"    {i}...", end="\r", flush=True)
        time.sleep(1)
    print(" " * 20, end="\r")


def main() -> int:
    if sys.platform != "win32":
        print("spike.py must run on Windows.")
        return 2

    awareness = display.set_dpi_awareness()
    check("Process is per-monitor DPI aware", awareness == "per_monitor", awareness)

    import mss
    from PIL import Image

    import uia
    import winapi
    from commit import TRACKED_TYPES
    from hooks import Hooks

    mons = display.monitors()
    check("Monitors with DPI", bool(mons), "; ".join(f"#{m.id} {m.rect} {m.dpi}dpi x{m.scale}{' primary' if m.primary else ''}" for m in mons))

    with uia.thread_init():
        countdown("Click into the MiniERP window in Edge now", 5)
        fg = winapi.foreground_hwnd()
        hwnd = winapi.visible_root_owner(fg)
        pid = winapi.window_pid(hwnd)
        proc = winapi.process_name(pid)
        cls = winapi.class_name(hwnd)
        rect = winapi.window_rect(hwnd)
        check("Foreground window", bool(hwnd and proc), f'{proc} class={cls} rect={rect} title="{winapi.window_text(hwnd)}"')
        aw, dpi = display.window_dpi_info(hwnd)
        mon = display.monitor_for_window(hwnd)
        check("Window DPI facts", True, f"awareness={aw} window_dpi={dpi} monitor=#{mon.id if mon else '?'} scale={mon.scale if mon else '?'}")

        url, ms = timed(lambda: uia.browser_url(hwnd))
        check("Address bar URL", bool(url), f"{url!r} ({ms:.0f} ms)")
        url2, ms2 = timed(lambda: uia.browser_url(hwnd))
        check("Address bar URL (cached)", url2 == url, f"{ms2:.0f} ms")

        private, ms = timed(lambda: uia.private_window(hwnd, ["InPrivate", "Incognito", "Private Browsing"]))
        check("Private-window check runs", True, f"private={private} ({ms:.0f} ms) - open an InPrivate window to confirm it says True")

        empty, ms = timed(lambda: uia.web_document_empty(hwnd))
        check("Web content visible to accessibility", empty is False,
              f"empty={empty} ({ms:.0f} ms). If True: restart Edge with --force-renderer-accessibility")

        walk, ms = timed(lambda: uia.walk_text(hwnd, cls == "Chrome_WidgetWin_1", 10, 300, 1.5))
        sample = ", ".join(repr(i.name)[:40] for i in (walk.items[:5] if walk else []))
        check("Text snapshot", bool(walk and walk.items),
              f"{len(walk.items) if walk else 0} items, visited {walk.visited if walk else 0}, truncated={walk.truncated if walk else '-'} ({ms:.0f} ms): {sample}")

        els, ms = timed(lambda: uia.tree(hwnd, cls == "Chrome_WidgetWin_1", 300, 1.5))
        check("Pointable elements (tree)", bool(els), f"{len(els)} elements ({ms:.0f} ms)")

        if rect:
            with mss.mss() as sct:
                raw = sct.grab({"left": rect[0], "top": rect[1], "width": rect[2] - rect[0], "height": rect[3] - rect[1]})
                img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
            out = HERE / "spike_shot.jpg"
            img.save(out, "JPEG", quality=80)
            check("Window-only screenshot", img.size == (rect[2] - rect[0], rect[3] - rect[1]),
                  f"{img.size} saved to {out.name} (open it: it should show exactly the window)")

        q = queue.Queue()
        hooks = Hooks(q.put_nowait, ctrl_down=winapi.ctrl_down)
        hooks.start()
        try:
            print("\n>>> Click a button in MiniERP (e.g. Post) within 15 seconds", flush=True)
            ev = wait_for(q, ("click",), 15)
            if ev is None:
                check("Mouse hook sees clicks", False, "no click seen")
            else:
                top = winapi.top_window_at(ev.x, ev.y)
                el, ms = timed(lambda: uia.element_at(ev.x, ev.y, {os.getpid()}, winapi.visible_root_owner(top)))
                inside = bool(el and el.rect and el.rect[0] - 2 <= ev.x <= el.rect[2] + 2 and el.rect[1] - 2 <= ev.y <= el.rect[3] + 2)
                check("Click -> element under the cursor", bool(el and el.name),
                      f"({ev.x},{ev.y}) -> {el.control_type if el else None} {el.name if el else None!r} ({ms:.0f} ms)")
                check("Click point inside the element's rect (scaling OK)", inside, f"rect={el.rect if el else None}")

            print("\n>>> Click into a password field (MiniERP login or any site) within 15 seconds", flush=True)
            deadline = time.time() + 15
            seen_pw = None
            while time.time() < deadline and seen_pw is None:
                f = uia.focused(TRACKED_TYPES)
                if f is not None and f.is_password:
                    seen_pw = f
                time.sleep(0.3)
            check("Password field detected (IsPassword) and value not read",
                  seen_pw is not None and seen_pw.value is None, f"name={seen_pw.name if seen_pw else None!r}")

            print("\n>>> Type a few letters in any text field, then press Enter (15 seconds)", flush=True)
            typed = wait_for(q, ("typing",), 15)
            check("Keyboard hook (timing only, no characters)", typed is not None)
            enter = wait_for(q, ("key",), 15)
            check("Enter key detected", enter is not None and enter.key in ("enter", "ctrl+enter"), enter.key if enter else "")
            f = uia.focused(TRACKED_TYPES)
            check("Focused field value readable", f is not None and f.value is not None,
                  f"{f.control_type if f else None} {f.name if f else None!r} value_len={len(f.value) if f and f.value else 0}")
        finally:
            hooks.stop()

    print("\n=== Summary (paste into docs/agents/a.md) ===")
    for name, ok, detail in results:
        print(f"- [{'x' if ok else ' '}] {name}: {detail}")
    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed" + (f"; failed: {', '.join(failed)}" if failed else ""))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
