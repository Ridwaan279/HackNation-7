import io
import json
import threading
from pathlib import Path

import pytest

from config import ConfigStore, iso_now, normalize_privacy, parse_iso, DEFAULT_PRIVACY
from model import WindowInfo
from privacy import PrivacyGate, domain_matches, parse_url
from protocol import Emitter, ROUTES, parse_command

REPO_CONFIG = Path(__file__).resolve().parents[2] / "config"


def win(process="msedge.exe", title="MiniERP - Microsoft Edge", pid=100, hwnd=1, cls="Chrome_WidgetWin_1"):
    return WindowInfo(hwnd=hwnd, pid=pid, process=process, title=title, class_name=cls,
                      rect=(0, 0, 1000, 800), monitor=1, monitor_rect=(0, 0, 1920, 1080),
                      monitor_scale=1.0, window_dpi=96, dpi_awareness="per_monitor")


@pytest.fixture
def store(tmp_path):
    s = ConfigStore(tmp_path / "runtime", REPO_CONFIG)
    s.load()
    return s


@pytest.fixture
def gate(store):
    return PrivacyGate(store, own_pids=[4242])


# -- protocol -------------------------------------------------------------------

def test_emitter_writes_ascii_json_lines():
    buf = io.StringIO()
    Emitter(buf).emit({"type": "text", "delta": ["Müller €"]})
    line = buf.getvalue()
    assert line.endswith("\n") and line.isascii()
    assert json.loads(line)["delta"] == ["Müller €"]


def test_emitter_is_thread_safe():
    buf = io.StringIO()
    em = Emitter(buf)
    threads = [threading.Thread(target=lambda i=i: [em.emit({"type": "x", "i": i, "n": n}) for n in range(200)]) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    lines = buf.getvalue().splitlines()
    assert len(lines) == 1600
    assert all(json.loads(l)["type"] == "x" for l in lines)


def test_emitter_survives_closed_stream():
    class Broken:
        def write(self, _):
            raise BrokenPipeError()
        def flush(self):
            pass
    em = Emitter(Broken())
    em.emit({"type": "x"})
    assert em.closed
    em.emit({"type": "y"})  # no exception


def test_pretty_mode():
    buf = io.StringIO()
    Emitter(buf, pretty=True).emit({"type": "click", "t": 0, "x": 1})
    assert "click" in buf.getvalue() and '"x": 1' in buf.getvalue()


@pytest.mark.parametrize("line,error", [
    ('{"id": 1, "cmd": "nope"}', "unknown command"),
    ('{"id": 2, "cmd": "redact"}', "string 'text'"),
    ('{"id": 3, "cmd": "mode", "value": "sleep"}', "mode must be"),
    ('{"id": 4, "cmd": "set_capture", "key": "x", "value": "ocr"}', "capture must be"),
    ('{"id": 5, "cmd": "a11y_ack", "key": "x", "choice": "maybe"}', "choice must be"),
    ('{"id": 6, "cmd": "tree", "max": "lots"}', "integer 'max'"),
])
def test_parse_command_errors(line, error):
    cmd, err = parse_command(line)
    assert cmd is None and err["ok"] is False and error in err["error"]
    assert err["id"] == json.loads(line)["id"]


@pytest.mark.parametrize("line", ["not json", "[1,2]", '{"cmd": "redact", "text": "x"}', '{"id": true, "cmd": "redact", "text": "x"}'])
def test_parse_command_unanswerable(line):
    assert parse_command(line) == (None, None)


def test_parse_command_ok_and_clamps_tree():
    cmd, err = parse_command('{"id": 7, "cmd": "tree", "max": 99999}')
    assert err is None and cmd["max"] == 2000
    cmd, err = parse_command('{"id": 8, "cmd": "redact", "text": "hi"}')
    assert err is None and cmd["text"] == "hi"


def test_every_contract_command_has_a_route():
    assert set(ROUTES) == {"redact", "tree", "mode", "shot", "set_capture", "reload_config", "a11y_ack"}


# -- config ---------------------------------------------------------------------

def test_first_load_creates_runtime_files(store):
    assert store.privacy_path.exists() and store.app_modes_path.exists()
    assert store.privacy["mask"]["cards"] is True
    assert "msedge.exe" in store.skiplists["browsers"]


def test_partial_privacy_file_is_merged(store):
    store.privacy_path.write_text(json.dumps({"mask": {"email": True}, "blocked_apps": ["slack.exe", 3]}), encoding="utf-8")
    store.load()
    assert store.privacy["mask"]["email"] is True
    assert store.privacy["mask"]["cards"] is True
    assert store.privacy["blocked_apps"] == ["slack.exe"]
    assert store.privacy["ambient_screenshots"] is True


def test_corrupt_files_fall_back_to_defaults(store):
    store.privacy_path.write_text("{oops", encoding="utf-8")
    store.app_modes_path.write_text("[]", encoding="utf-8")
    store.load()
    assert store.privacy == normalize_privacy(None, DEFAULT_PRIVACY)
    assert store.app_modes == {}


def test_update_app_mode_is_read_modify_write(store):
    store.update_app_mode("excel.exe", capture="vision")
    # Someone else (the dashboard) writes another entry directly.
    data = json.loads(store.app_modes_path.read_text(encoding="utf-8"))
    data["word.exe"] = {"capture": "uia"}
    store.app_modes_path.write_text(json.dumps(data), encoding="utf-8")
    store.update_app_mode("excel.exe", rect_scale=0.5, capture=None)
    data = json.loads(store.app_modes_path.read_text(encoding="utf-8"))
    assert data == {"excel.exe": {"rect_scale": 0.5}, "word.exe": {"capture": "uia"}}


def test_block_key(store):
    store.block_key("browser:legacy.example")
    store.block_key("oldapp.exe")
    store.block_key("oldapp.exe")
    assert store.privacy["blocked_domains"] == ["legacy.example"]
    assert store.privacy["blocked_apps"] == ["oldapp.exe"]
    on_disk = json.loads(store.privacy_path.read_text(encoding="utf-8"))
    assert on_disk["blocked_apps"] == ["oldapp.exe"]


def test_iso_roundtrip():
    assert parse_iso(iso_now(1727980000)) == 1727980000.0
    assert parse_iso("garbage") is None and parse_iso(None) is None


# -- URL parsing ------------------------------------------------------------------

@pytest.mark.parametrize("text,expected", [
    ("minierp.local/invoices/4471", (None, "minierp.local")),
    ("https://www.Example.com:8443/x?y#z", ("https", "example.com")),
    ("localhost:5173/", (None, "localhost")),
    ("http://127.0.0.1:8080", ("http", "127.0.0.1")),
    ("chrome://settings/passwords", ("chrome", "settings")),
    ("edge://newtab/", ("edge", "newtab")),
    ("about:blank", ("about", "blank")),
    ("file:///C:/temp/a.html", ("file", "local-file")),
    ("file:///C:/UNI 3rd year/sidecar/spike_page.html", ("file", "local-file")),
    ("C:/UNI 3rd year/sidecar/spike_page.html", ("file", "local-file")),
    ("user:pw@intranet.corp/x", (None, "intranet.corp")),
    ("bank of america", (None, None)),
    ("invoice", (None, None)),
    ("", (None, None)),
    (None, (None, None)),
])
def test_parse_url(text, expected):
    assert parse_url(text) == expected


def test_domain_matches():
    assert domain_matches("mybank.com", "*.mybank.com")
    assert domain_matches("login.mybank.com", "mybank.com")
    assert not domain_matches("notmybank.com", "mybank.com")
    assert not domain_matches("x.com", "")


# -- privacy gate -------------------------------------------------------------------

def test_allowed_browser_page_gets_domain_key(gate):
    d = gate.decide(win(), "minierp.local/invoices", False, "ambient")
    assert d == d.__class__(False, None, "browser:minierp.local", "minierp.local")


def test_allowed_app_key_is_lowercase_process(gate):
    d = gate.decide(win(process="EXCEL.EXE", title="Q3.xlsx - Excel", cls="XLMAIN"), None, False, "session")
    assert not d.blocked and d.key == "excel.exe"


@pytest.mark.parametrize("kwargs,url,private,mode,reason", [
    (dict(), "minierp.local", False, "paused", "paused"),
    (dict(pid=4242), "minierp.local", False, "ambient", "self"),
    (dict(process="consent.exe", title="UAC"), None, False, "ambient", "system"),
    (dict(process="1Password.exe", title="1Password"), None, False, "ambient", "password_manager"),
    (dict(title="Bitwarden - Microsoft Edge"), "vault.example.org", False, "ambient", "password_manager"),
    (dict(), "chrome://settings/passwords", False, "ambient", "system"),
    (dict(title="New InPrivate tab - Microsoft Edge"), "minierp.local", False, "ambient", "private_window"),
    (dict(), "minierp.local", True, "ambient", "private_window"),
    (dict(), "secure.chase.com/login", False, "ambient", "banking"),
    (dict(), "www.deutsche-bank.de", False, "ambient", "banking"),
    (dict(title="Online Banking - Google Chrome", process="chrome.exe"), None, False, "ambient", "banking"),
])
def test_blocked_reasons(gate, kwargs, url, private, mode, reason):
    d = gate.decide(win(**kwargs), url, private, mode)
    assert d.blocked and d.reason == reason


def test_internal_new_tab_is_not_blocked(gate):
    assert not gate.decide(win(), "edge://newtab/", False, "ambient").blocked


def test_user_block_lists(store, gate):
    store.privacy["blocked_apps"] = ["Slack", "browser:mail.example.com"]
    store.privacy["blocked_domains"] = ["*.intranet.corp"]
    assert gate.decide(win(process="slack.exe", title="Slack"), None, False, "ambient").reason == "user_blocked"
    assert gate.decide(win(), "mail.example.com/inbox", False, "ambient").reason == "user_blocked"
    assert gate.decide(win(), "hr.intranet.corp/payroll", False, "ambient").reason == "user_blocked"
    assert not gate.decide(win(), "minierp.local", False, "ambient").blocked


def test_allow_only(store, gate):
    store.privacy["allow_only"] = ["excel", "minierp.local"]
    assert not gate.decide(win(process="EXCEL.EXE", cls="XLMAIN"), None, False, "ambient").blocked
    assert not gate.decide(win(), "minierp.local/x", False, "ambient").blocked
    assert gate.decide(win(), "news.example.com", False, "ambient").reason == "user_blocked"
    assert gate.decide(win(process="notepad.exe", cls="Notepad"), None, False, "ambient").reason == "user_blocked"


def test_skip_toggles_can_be_turned_off(store, gate):
    store.privacy["skip"] = {"banking": False, "password_managers": False, "private_windows": False}
    assert not gate.decide(win(), "secure.chase.com", False, "ambient").blocked
    assert not gate.decide(win(process="1password.exe", title="1Password"), None, False, "ambient").blocked
    assert not gate.decide(win(), "minierp.local", True, "ambient").blocked


def test_browser_without_url_uses_process_key(gate):
    d = gate.decide(win(), None, False, "ambient")
    assert not d.blocked and d.key == "msedge.exe" and d.domain is None


def test_helpers(gate):
    assert gate.is_browser(win())
    assert gate.is_remote_session(win(process="mstsc.exe"))
    assert "InPrivate" in gate.private_markers()
