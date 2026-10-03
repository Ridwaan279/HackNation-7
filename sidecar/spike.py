#!/usr/bin/env python3
"""Phase 1 spike (Windows): checks every OS capability the observer relies on.

    cd sidecar
    python -m pip install -r requirements.txt
    python spike.py

It opens spike_page.html (a MiniERP stand-in) in Edge, then asks you to click
a button, click into the password box and type in a field (about 2 minutes).
Paste the summary into docs/agents/a.md. It exercises the same adapter code
the observer uses (display.py, winapi.py, uia.py, hooks.py).
"""
import sys

sys.coinit_flags = 0  # same COM setup as observer.py

import os  # noqa: E402
import queue  # noqa: E402
import subprocess  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import display  # noqa: E402

TEST_PAGE = HERE / "spike_page.html"
BROWSERS = {"msedge.exe", "chrome.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe", "arc.exe", "chromium.exe"}
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


def drain(q):
    while True:
        try:
            q.get_nowait()
        except queue.Empty:
            return


def open_test_page() -> str:
    """Open spike_page.html in Edge (no shell, so paths with spaces or % are safe)."""
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
        if base:
            exe = Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe"
            if exe.exists():
                subprocess.Popen([str(exe), TEST_PAGE.as_uri()])
                return "Edge"
    os.startfile(str(TEST_PAGE))  # noqa: S606 - Windows only
    return "your default browser"


def wait_for_browser(winapi, seconds=30):
    """Wait until a browser window is in front (the terminal is in front when the spike starts)."""
    print(f"\n>>> Click into the browser window showing the test page. Waiting up to {seconds} s...", flush=True)
    deadline = time.time() + seconds
    last = None
    hwnd, proc = 0, ""
    while time.time() < deadline:
        fg = winapi.foreground_hwnd()
        hwnd = winapi.visible_root_owner(fg) if fg else 0
        proc = winapi.process_name(winapi.window_pid(hwnd)) if hwnd else ""
        if proc.lower() in BROWSERS:
            time.sleep(1.0)  # let the page finish loading after the window comes to the front
            return hwnd, proc
        if proc != last:
            print(f"    in front: {proc or '(nothing)'} - waiting for a browser window...", flush=True)
            last = proc
        time.sleep(0.25)
    return hwnd, proc


def main() -> int:
    if sys.platform != "win32":
        print("spike.py must run on Windows.")
        return 2

    awareness = display.set_dpi_awareness()
    check("Process is per-monitor DPI aware", awareness == "per_monitor", awareness)

    from PIL import Image

    import uia
    import winapi
    from backend_windows import new_mss
    from commit import TRACKED_TYPES
    from hooks import Hooks
    from redact import Redactor
    from textsnap import classify

    mons = display.monitors()
    check("Monitors with DPI", bool(mons), "; ".join(f"#{m.id} {m.rect} {m.dpi}dpi x{m.scale}{' primary' if m.primary else ''}" for m in mons))

    with uia.thread_init():
        where = open_test_page()
        print(f"\nOpened the test page ({TEST_PAGE.name}) in {where}.", flush=True)
        hwnd, proc = wait_for_browser(winapi)
        cls = winapi.class_name(hwnd) if hwnd else ""
        rect = winapi.window_rect(hwnd) if hwnd else None
        is_browser = proc.lower() in BROWSERS
        check("Browser window in front", is_browser,
              f'{proc or "(nothing)"} class={cls} rect={rect} title="{winapi.window_text(hwnd) if hwnd else ""}"'
              + ("" if is_browser else "  <- click into the browser during the wait, then run the spike again"))
        aw, dpi = display.window_dpi_info(hwnd)
        mon = display.monitor_for_window(hwnd)
        check("Window DPI facts", True, f"awareness={aw} window_dpi={dpi} monitor=#{mon.id if mon else '?'} scale={mon.scale if mon else '?'}")

        url, ms = timed(lambda: uia.browser_url(hwnd))
        check("Address bar URL", bool(url), f"{url!r} ({ms:.0f} ms)")
        url2, ms2 = timed(lambda: uia.browser_url(hwnd))
        check("Address bar URL (cached)", url is not None and url2 == url, f"{ms2:.0f} ms")

        private, ms = timed(lambda: uia.private_window(hwnd, ["InPrivate", "Incognito", "Private Browsing"]))
        check("Private-window check runs", True, f"private={private} ({ms:.0f} ms) - open an InPrivate window to confirm it says True")

        docs = uia.document_diagnostics(hwnd)
        print("    web documents (largest first): " + (" | ".join(docs) if docs else "none"), flush=True)
        empty, ms = timed(lambda: uia.web_document_empty(hwnd))
        check("Web content visible to accessibility", empty is False,
              f"empty={empty} ({ms:.0f} ms). If True: restart Edge with --force-renderer-accessibility")

        print("    reading the page text (up to 2 s)...", flush=True)
        walk, ms = timed(lambda: uia.walk_text(hwnd, "browser", 10, 300, 1.5))
        if not (walk and walk.items):
            print("    nothing yet; retrying in 2 s (the page tree may still be building)...", flush=True)
            time.sleep(2.0)
            walk, ms = timed(lambda: uia.walk_text(hwnd, "browser", 10, 300, 1.5))
        names = [i.name for i in (walk.items if walk else []) if i.name]
        check("Text snapshot (page only)", bool(walk and walk.items),
              f"{len(walk.items) if walk else 0} items, visited {walk.visited if walk else 0}, "
              f"truncated={walk.truncated if walk else '-'} ({ms:.0f} ms): " + ", ".join(repr(n)[:30] for n in names[:6]))
        lines, sensitive, _ = classify(walk.items if walk else [], Redactor())
        masked = [line for line in lines if "[IBAN" in line or "[CARD" in line]
        check("Masking applied to page text", bool(masked), (masked[0] if masked else "no masked line found") +
              f"; {len(sensitive)} field(s) to blur")
        pw_items = [i for i in (walk.items if walk else []) if i.is_password]
        check("Password field found, value not read", bool(pw_items) and all(i.value is None for i in pw_items),
              f"{len(pw_items)} password field(s)")

        print("    listing clickable elements (up to 2 s)...", flush=True)
        els, ms = timed(lambda: uia.tree(hwnd, "browser", 300, 1.5))
        check("Pointable elements (tree)", any(e.name == "Post" for e in els),
              f"{len(els)} elements ({ms:.0f} ms): " + ", ".join(f"{e.control_type} {e.name!r}"[:30] for e in els[:6]))

        if rect:
            with new_mss() as sct:
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
            print("\n>>> Click the blue 'Post' button on the test page (15 seconds)", flush=True)
            drain(q)
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

            print("\n>>> Click into the 'Password' box on the test page (15 seconds)", flush=True)
            deadline = time.time() + 15
            seen_pw = None
            while time.time() < deadline and seen_pw is None:
                f = uia.focused(TRACKED_TYPES)
                if f is not None and f.is_password:
                    seen_pw = f
                time.sleep(0.3)
            check("Focused password box detected, value not read",
                  seen_pw is not None and seen_pw.value is None, f"name={seen_pw.name if seen_pw else None!r}")

            print("\n>>> Click into 'Cost center' and type a few letters (15 seconds)", flush=True)
            drain(q)
            typed = wait_for(q, ("typing",), 15)
            check("Keyboard hook (timing only, no characters)", typed is not None)
            field = None
            deadline = time.time() + 2
            while time.time() < deadline and field is None:  # read the value while still in the field
                f = uia.focused(TRACKED_TYPES)
                if f is not None and f.control_type in TRACKED_TYPES and f.value:
                    field = f
                time.sleep(0.2)
            check("Focused field value readable", field is not None,
                  f"{field.control_type if field else None} {field.name if field else None!r} "
                  f"value_len={len(field.value) if field and field.value else 0}")

            print("\n>>> Now press Enter (15 seconds)", flush=True)
            enter = wait_for(q, ("key",), 15)
            check("Enter key detected", enter is not None and enter.key in ("enter", "ctrl+enter"), enter.key if enter else "")
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
