"""The real runner (threads, stdin/stdout protocol) as a subprocess, like Electron runs it."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

SIDECAR = Path(__file__).resolve().parents[1]
OBSERVER = SIDECAR / "observer.py"


def start(tmp_path, *extra):
    return subprocess.Popen(
        [sys.executable, str(OBSERVER), "--fake", "--data-dir", str(tmp_path / "data"),
         "--config-dir", str(tmp_path / "config"), "--parent-pid", str(os.getpid()), *extra],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")


def read_until(proc, pred, timeout=10.0):
    seen = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        obj = json.loads(line)  # every stdout line must be valid JSON
        seen.append(obj)
        if pred(obj):
            return obj, seen
    raise AssertionError(f"condition not met; saw {seen}")


def send(proc, obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def test_fake_runner_end_to_end(tmp_path):
    proc = start(tmp_path)
    try:
        ready, _ = read_until(proc, lambda o: o.get("type") == "ready")
        assert ready["backend"] == "fake"
        ctx, seen = read_until(proc, lambda o: o.get("type") == "context")
        assert ctx["key"] == "browser:minierp.local"
        assert any(o.get("type") == "displays" for o in seen)

        send(proc, {"id": 1, "cmd": "redact", "text": "IBAN DE89 3704 0044 0532 0130 00"})
        reply, _ = read_until(proc, lambda o: o.get("id") == 1)
        assert reply == {"id": 1, "ok": True, "text": "IBAN [IBAN ••••3000]"}

        send(proc, {"id": 2, "cmd": "tree", "max": 10})
        reply, _ = read_until(proc, lambda o: o.get("id") == 2)
        assert reply["ok"] and {c["name"] for c in reply["controls"]} == {"Cost center", "Post"}

        send(proc, {"id": 3, "cmd": "shot", "reason": "on_demand"})
        reply, _ = read_until(proc, lambda o: o.get("id") == 3)
        assert reply["ok"] and (tmp_path / "data" / reply["path"]).exists()

        send(proc, {"id": 4, "cmd": "mode", "value": "paused"})
        reply, seen = read_until(proc, lambda o: o.get("id") == 4)
        assert reply["ok"]

        send(proc, {"id": 5, "cmd": "nope"})
        reply, _ = read_until(proc, lambda o: o.get("id") == 5)
        assert reply["ok"] is False and "unknown command" in reply["error"]

        proc.stdin.write("this is not json\n")
        send(proc, {"id": 6, "cmd": "mode", "value": "ambient"})
        reply, _ = read_until(proc, lambda o: o.get("id") == 6)
        assert reply["ok"]
    finally:
        proc.stdin.close()  # EOF = parent gone: the sidecar must exit by itself
        code = proc.wait(timeout=10)
        err = proc.stderr.read()
    assert code == 0, err
    assert "started: backend=fake" in err


def test_stray_prints_never_reach_the_protocol_stream(tmp_path):
    code = (
        "import sys; sys.path.insert(0, %r)\n"
        "import observer\n"
        "proto = observer.isolate_stdout()\n"
        "print('stray library output')\n"
        "import os; os.write(1, b'raw fd write\\n')\n"
        "proto.write('{\"type\":\"ok\"}\\n'); proto.flush()\n"
    ) % str(SIDECAR)
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=20)
    assert out.stdout == '{"type":"ok"}\n'
    assert "stray library output" in out.stderr and "raw fd write" in out.stderr


def test_real_backend_refuses_to_start_off_windows(tmp_path):
    if sys.platform == "win32":
        return
    out = subprocess.run([sys.executable, str(OBSERVER), "--data-dir", str(tmp_path)], capture_output=True,
                         text=True, timeout=20, stdin=subprocess.DEVNULL)
    assert out.returncode == 2 and "needs Windows" in out.stderr and out.stdout == ""


def test_redact_only_answers_redact_and_nothing_else(tmp_path):
    # Electron's OBSERVER_FAKE mode: fixture replay with real masking, no screen access.
    proc = subprocess.run(
        [sys.executable, str(OBSERVER), "--redact-only", "--data-dir", str(tmp_path / "data"),
         "--config-dir", str(tmp_path / "config"), "--mode", "ambient"],
        input="\n".join(json.dumps(c) for c in [
            {"id": 1, "cmd": "redact", "text": "Pay to DE89 3704 0044 0532 0130 ff00"},
            {"id": 2, "cmd": "tree"},
            {"id": 3, "cmd": "shot", "reason": "on_demand"},
            {"id": 4, "cmd": "reload_config"},
        ]) + "\n",
        capture_output=True, text=True, encoding="utf-8", timeout=20)
    assert proc.returncode == 0, proc.stderr
    lines = [json.loads(line) for line in proc.stdout.splitlines()]
    assert lines[0]["type"] == "ready" and lines[0]["backend"] == "fake"
    replies = {r["id"]: r for r in lines[1:]}
    assert replies[1] == {"id": 1, "ok": True, "text": "Pay to [IBAN]"}
    assert replies[2]["ok"] is False and replies[3]["ok"] is False
    assert replies[4] == {"id": 4, "ok": True}
    assert len(lines) == 5  # no context, click or shot events
    assert (tmp_path / "config" / "privacy.json").exists()
