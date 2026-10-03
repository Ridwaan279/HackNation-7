#!/usr/bin/env python3
"""AI Apprentice observer sidecar (Agent A).

Electron's observer.ts spawns this process and talks to it with JSON lines:
events and replies on stdout, commands on stdin (shapes in shared/contracts.ts).

    python observer.py --print                 # human-readable events in the terminal (Windows)
    python observer.py --print --mode session  # also take click screenshots
    python observer.py --fake --print          # demo scene, any OS

Options: --data-dir (default %APPDATA%/apprentice), --config-dir (default <data-dir>/config),
--defaults-dir (default <repo>/config), --parent-pid (Electron's pid, so its windows are ignored).
"""
import sys

# Must happen before comtypes/uiautomation are imported: use a multithreaded COM apartment.
sys.coinit_flags = 0

import argparse  # noqa: E402
import os  # noqa: E402
import queue  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import traceback  # noqa: E402
from pathlib import Path  # noqa: E402

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import display  # noqa: E402  (safe on any OS; only ctypes on Windows)


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="AI Apprentice observer sidecar")
    p.add_argument("--print", action="store_true", help="human-readable events instead of JSON lines")
    p.add_argument("--fake", action="store_true", help="use the in-memory demo backend (any OS)")
    p.add_argument("--mode", choices=("ambient", "session", "tutor", "paused"), default="ambient")
    p.add_argument("--data-dir")
    p.add_argument("--config-dir")
    p.add_argument("--defaults-dir")
    p.add_argument("--parent-pid", type=int, default=0)
    return p.parse_args(argv)


def default_data_dir() -> Path:
    if sys.platform == "win32" and os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "apprentice"
    return Path.home() / ".apprentice"


def isolate_stdout():
    """Reserve the real stdout for protocol lines.

    Libraries that print (uiautomation's logger writes to stdout) would corrupt
    the JSON stream, so fd 1 and sys.stdout are pointed at stderr and the
    protocol gets a private duplicate of the original stdout.
    """
    sys.stdout.flush()
    proto_fd = os.dup(1)
    if sys.platform == "win32":
        import msvcrt
        msvcrt.setmode(proto_fd, os.O_BINARY)  # no "\n" -> "\r\n" translation
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(proto_fd, "w", encoding="utf-8", newline="\n", buffering=1)


def configure_stdin() -> None:
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


class Runner:
    def __init__(self, engine, backend, emitter, log):
        self.engine = engine
        self.backend = backend
        self.emitter = emitter
        self.log = log
        self.fast_q: "queue.Queue" = queue.Queue()
        self.slow_q: "queue.Queue" = queue.Queue()
        self.stop = threading.Event()
        self._last_error_log = {}

    def run(self) -> int:
        from protocol import ROUTES, parse_command

        self.engine.start()
        threads = [threading.Thread(target=self._fast_loop, name="observer-fast", daemon=True),
                   threading.Thread(target=self._slow_loop, name="observer-slow", daemon=True)]
        for t in threads:
            t.start()
        try:
            self.backend.start_hooks(self.fast_q.put_nowait)
        except Exception as ex:
            self.log(f"input hooks could not start: {ex}")
        try:
            for line in sys.stdin:
                if self.emitter.closed:
                    break
                line = line.strip()
                if not line:
                    continue
                cmd, err = parse_command(line)
                if err is not None:
                    self.emitter.emit(err)
                    continue
                if cmd is None:
                    self.log("ignoring an unreadable command line")
                    continue
                route = ROUTES[cmd["cmd"]]
                if route == "inline":
                    self.emitter.emit(self.engine.execute(cmd))
                elif route == "fast":
                    self.fast_q.put(cmd)
                else:
                    self.slow_q.put(cmd)
        except KeyboardInterrupt:
            pass
        finally:
            self.stop.set()
            try:
                self.backend.stop()
            except Exception:
                pass
            for t in threads:
                t.join(timeout=2.0)
        return 0

    def _error(self, where: str) -> None:
        now = time.monotonic()
        if now - self._last_error_log.get(where, 0.0) > 5.0:
            self._last_error_log[where] = now
            self.log(f"error in {where} loop:\n{traceback.format_exc()}")

    def _fast_loop(self) -> None:
        with self.backend.thread_init():
            while not self.stop.is_set():
                try:
                    item = self.fast_q.get(timeout=0.05)
                except queue.Empty:
                    item = None
                try:
                    if isinstance(item, dict):
                        self.emitter.emit(self.engine.execute(item))
                    elif item is not None:
                        self.engine.on_hook(item)
                    self.engine.fast_tick()
                except Exception:
                    self._error("fast")

    def _slow_loop(self) -> None:
        with self.backend.thread_init():
            while not self.stop.is_set():
                try:
                    item = self.slow_q.get(timeout=0.2)
                except queue.Empty:
                    item = None
                try:
                    if item is not None:
                        self.emitter.emit(self.engine.execute(item))
                    self.engine.slow_tick()
                except Exception:
                    self._error("slow")


def main(argv=None) -> int:
    args = parse_args(argv)
    if not args.fake:
        display.set_dpi_awareness()  # before anything imports uiautomation or mss
    proto = isolate_stdout()
    configure_stdin()

    from config import ConfigStore, log
    from engine import Engine
    from protocol import Emitter

    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    config_dir = Path(args.config_dir) if args.config_dir else data_dir / "config"
    defaults_dir = Path(args.defaults_dir) if args.defaults_dir else HERE.parent / "config"
    store = ConfigStore(config_dir, defaults_dir)
    store.load()
    own_pids = {os.getpid()} | ({args.parent_pid} if args.parent_pid > 0 else set())

    if args.fake:
        from backend_fake import FakeBackend
        backend = FakeBackend.demo()
    elif sys.platform != "win32":
        log("the real backend needs Windows; run with --fake on other systems")
        return 2
    else:
        from backend_windows import WindowsBackend
        backend = WindowsBackend(own_pids)

    emitter = Emitter(proto, pretty=args.print)
    engine = Engine(backend, emitter, store, data_dir, own_pids=own_pids, mode=args.mode)
    log(f"started: backend={backend.name} mode={args.mode} data={data_dir}")
    return Runner(engine, backend, emitter, log).run()


if __name__ == "__main__":
    sys.exit(main())
