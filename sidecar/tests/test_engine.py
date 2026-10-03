import json
from pathlib import Path

import pytest
from PIL import Image, ImageStat

from backend_fake import FakeBackend, element, make_window
from config import ConfigStore
from engine import Engine
from model import FocusInfo, HookEvent, MonitorInfo, WalkItem, WalkResult

REPO_CONFIG = Path(__file__).resolve().parents[2] / "config"
OWN_PID = 4242


class Clock:
    def __init__(self, t=1_000_000.0):
        self.t = t

    def __call__(self):
        return self.t

    def tick(self, dt):
        self.t += dt
        return self.t


class Collector:
    def __init__(self):
        self.events = []

    def emit(self, obj):
        # Round-trip through JSON exactly like the real emitter does.
        self.events.append(json.loads(json.dumps(obj, ensure_ascii=True)))

    def of(self, kind):
        return [e for e in self.events if e.get("type") == kind]

    def clear(self):
        self.events.clear()


@pytest.fixture
def env(tmp_path):
    clock = Clock()
    backend = FakeBackend()
    store = ConfigStore(tmp_path / "config", REPO_CONFIG)
    store.load()
    out = Collector()

    def build(mode="ambient"):
        eng = Engine(backend, out, store, tmp_path / "data", own_pids=[OWN_PID], mode=mode, clock=clock)
        eng.start()
        return eng

    class Env:
        pass

    e = Env()
    e.clock, e.backend, e.store, e.out, e.build, e.data = clock, backend, store, out, build, tmp_path / "data"
    return e


def erp(backend, **kw):
    win = make_window(**kw)
    backend.add_window(win, url="minierp.local/invoices/4471", elements=[
        element("Cost center", "Edit", (600, 300, 760, 325), automation_id="costCenter"),
        element("Password", "Edit", (600, 500, 760, 525), is_password=True),
        element("Post", "Button", (780, 425, 850, 455), automation_id="post"),
    ])
    return win


def click(eng, x, y, t, button="left"):
    eng.on_hook(HookEvent("click", t, x=x, y=y, button=button))


# -- startup & context ------------------------------------------------------------

def test_start_emits_ready_and_displays(env):
    env.build()
    ready, displays = env.out.events[0], env.out.events[1]
    assert ready["type"] == "ready" and ready["backend"] == "fake" and ready["dpi_awareness"] == "per_monitor"
    assert displays["type"] == "displays" and displays["monitors"][0]["rect_px"] == [0, 0, 1920, 1080]


def test_context_for_allowed_window_with_masked_title(env):
    erp(env.backend, title="Card 4242 4242 4242 4242 - Microsoft Edge")
    eng = env.build()
    eng.fast_tick()
    [ctx] = env.out.of("context")
    assert ctx["key"] == "browser:minierp.local" and ctx["app"] == "msedge.exe"
    assert ctx["title"] == "Card [CARD ••••4242] - Microsoft Edge"
    assert ctx["capture"] == "uia" and ctx["window_rect"] == [0, 0, 1280, 800]
    eng.fast_tick()
    assert len(env.out.of("context")) == 1  # unchanged context isn't repeated


def test_password_manager_is_blocked_and_never_read(env):
    erp(env.backend)
    eng = env.build()
    eng.fast_tick()
    pm = make_window(hwnd=2, pid=200, process="1Password.exe", title="1Password", class_name="1PW")
    env.backend.add_window(pm, walk=WalkResult(items=[WalkItem("Text", "my secret vault", None, False)]))
    env.backend.calls.clear()
    env.clock.tick(1)
    eng.fast_tick()
    eng.slow_tick()
    click(eng, 10, 10, env.clock.tick(0.1))
    eng.on_hook(HookEvent("key", env.clock.t, key="enter"))
    assert env.out.events[-1] == {"type": "blocked", "t": env.clock.t - 0.1, "reason": "password_manager"}
    assert env.backend.calls["walk_text"] == 0 and env.backend.calls["capture"] == 0
    assert env.backend.calls["element_at"] == 0 and env.backend.calls["focused"] == 0
    assert not env.out.of("text") and not env.out.of("click") and not env.out.of("key")


def test_navigation_to_bank_is_blocked_even_on_immediate_click(env):
    erp(env.backend)
    eng = env.build(mode="session")
    eng.fast_tick()
    env.backend.urls[1] = "online.mybank.com/login"  # same tab, before the next 500 ms poll
    click(eng, 800, 440, env.clock.tick(0.1))
    assert env.out.events[-1]["type"] == "blocked" and env.out.events[-1]["reason"] == "banking"
    assert not env.out.of("click") and env.backend.calls["capture"] == 0


# -- clicks -------------------------------------------------------------------------

def test_session_click_has_target_and_annotated_shot(env):
    erp(env.backend)
    eng = env.build(mode="session")
    eng.fast_tick()
    click(eng, 800, 440, env.clock.tick(0.1))
    [c] = env.out.of("click")
    assert c["target"] == {"name": "Post", "control_type": "Button", "automation_id": "post",
                           "rect": [780, 425, 850, 455], "rect_trusted": True}
    assert c["shot"].startswith("shots/") and (env.data / c["shot"]).exists()
    assert c["shot_meta"] == {"origin_px": [0, 0], "size_px": [1280, 800], "scale": 1.0, "monitor": 1, "auto_blur": True}


def test_click_on_password_field_is_blurred_in_shot(env):
    erp(env.backend)
    eng = env.build(mode="session")
    eng.fast_tick()
    click(eng, 650, 510, env.clock.tick(0.1))
    [c] = env.out.of("click")
    assert c["target"]["name"] == "Password"
    img = Image.open(env.data / c["shot"]).convert("L")
    inside = ImageStat.Stat(img.crop((610, 503, 750, 522))).stddev[0]
    outside = ImageStat.Stat(img.crop((100, 503, 240, 522))).stddev[0]
    assert inside < outside * 0.3


def test_ambient_click_has_no_shot_and_tutor_uia_click_has_no_shot(env):
    erp(env.backend)
    eng = env.build(mode="ambient")
    eng.fast_tick()
    click(eng, 800, 440, env.clock.tick(0.1))
    eng._set_mode("tutor")
    eng.fast_tick()
    click(eng, 800, 440, env.clock.tick(0.1))
    clicks = env.out.of("click")
    assert len(clicks) == 2 and all(c["shot"] is None and c["shot_meta"] is None for c in clicks)
    assert all(c["target"]["name"] == "Post" for c in clicks)
    assert env.backend.calls["capture"] == 0


def test_click_on_own_window_is_ignored(env):
    erp(env.backend)
    env.backend.add_window(make_window(hwnd=9, pid=OWN_PID, process="electron.exe", rect=(1500, 800, 1700, 1000)), foreground=False)
    eng = env.build(mode="session")
    eng.fast_tick()
    click(eng, 1600, 900, env.clock.tick(0.1))
    assert not env.out.of("click")


def test_click_on_other_window_emits_context_first(env):
    erp(env.backend)
    excel = make_window(hwnd=3, pid=300, process="EXCEL.EXE", title="Q3.xlsx - Excel", class_name="XLMAIN",
                        rect=(1300, 0, 1900, 800))
    env.backend.add_window(excel, foreground=False, elements=[element("Sheet1", "TabItem", (1310, 760, 1400, 790), pid=300)])
    eng = env.build()
    eng.fast_tick()
    env.out.clear()
    click(eng, 1350, 770, env.clock.tick(0.1))
    assert [e["type"] for e in env.out.events] == ["context", "click"]
    assert env.out.events[0]["key"] == "excel.exe"
    # The foreground poll still returns Edge for a moment: the clicked window sticks.
    eng.fast_tick()
    assert env.out.events[-1]["type"] == "click"


# -- commits ---------------------------------------------------------------------------

def test_commit_idle_then_final_on_tab_and_masking(env):
    erp(env.backend)
    eng = env.build()
    f = lambda v, key=("cc",), name="Cost center": FocusInfo(key=key, name=name, control_type="Edit", automation_id="",
                                                           value=v, is_password=False, rect=(600, 300, 760, 325), pid=100)
    env.backend.focus = f("4711")
    eng.fast_tick()
    env.backend.focus = f("0400")
    env.clock.tick(0.35); eng.fast_tick()
    env.clock.tick(0.35); eng.fast_tick()
    env.clock.tick(0.35); eng.fast_tick()
    env.clock.tick(0.35); eng.fast_tick()
    [idle] = env.out.of("commit")
    assert (idle["field"], idle["old"], idle["new"], idle["final"], idle["masked"]) == ("Cost center", "4711", "0400", False, False)
    env.backend.focus = f("Pay to DE89 3704 0044 0532 0130 00", key=("notes",), name="Notes")
    env.clock.tick(0.35); eng.fast_tick()
    env.backend.focus = f("x", key=("notes",), name="Notes")
    eng.on_hook(HookEvent("key", env.clock.tick(0.1), key="tab"))
    commits = env.out.of("commit")
    assert len(commits) == 2
    assert commits[1]["old"] == "Pay to [IBAN ••••3000]" and commits[1]["masked"] and commits[1]["final"]
    assert env.out.of("key")[-1]["key"] == "tab"


def test_password_field_values_never_emitted(env):
    erp(env.backend)
    eng = env.build()
    env.backend.focus = FocusInfo(key=("pw",), name="Password", control_type="Edit", automation_id="", value=None,
                                  is_password=True, rect=(600, 500, 760, 525), pid=100)
    for _ in range(10):
        env.clock.tick(0.35)
        eng.fast_tick()
    eng.on_hook(HookEvent("key", env.clock.tick(0.1), key="enter"))
    assert not env.out.of("commit")


def test_leaving_the_app_flushes_the_field_first(env):
    erp(env.backend)
    eng = env.build()
    env.backend.focus = FocusInfo(key=("cc",), name="Cost center", control_type="Edit", automation_id="", value="1",
                                  is_password=False, rect=None, pid=100)
    eng.fast_tick()
    env.backend.focus = FocusInfo(key=("cc",), name="Cost center", control_type="Edit", automation_id="", value="12",
                                  is_password=False, rect=None, pid=100)
    env.clock.tick(0.35); eng.fast_tick()
    env.backend.add_window(make_window(hwnd=2, pid=200, process="1password.exe", title="1Password"))
    env.clock.tick(0.6); eng.fast_tick()
    kinds = [e["type"] for e in env.out.events]
    assert kinds[-2:] == ["commit", "blocked"]
    assert env.out.of("commit")[0]["new"] == "12" and env.out.of("commit")[0]["final"]


# -- pause / off the record ---------------------------------------------------------------

def test_pause_drops_pending_typing_and_goes_silent(env):
    erp(env.backend)
    eng = env.build(mode="session")
    env.backend.focus = FocusInfo(key=("cc",), name="Cost center", control_type="Edit", automation_id="", value="1",
                                  is_password=False, rect=None, pid=100)
    eng.fast_tick()
    env.backend.focus = FocusInfo(key=("cc",), name="Cost center", control_type="Edit", automation_id="",
                                  value="typed before pausing", is_password=False, rect=None, pid=100)
    env.clock.tick(0.35); eng.fast_tick()
    reply = eng.execute({"id": 1, "cmd": "mode", "value": "paused"})
    assert reply == {"id": 1, "ok": True}
    assert env.out.events[-1]["type"] == "blocked" and env.out.events[-1]["reason"] == "paused"
    env.backend.calls.clear()
    n = len(env.out.events)
    for _ in range(20):
        env.clock.tick(0.5)
        eng.fast_tick()
        eng.slow_tick()
    click(eng, 800, 440, env.clock.t)
    eng.on_hook(HookEvent("typing", env.clock.t))
    assert not env.out.of("commit")
    assert all(e["type"] == "displays" for e in env.out.events[n:])
    assert env.backend.calls["focused"] == 0 and env.backend.calls["capture"] == 0 and env.backend.calls["browser_url"] == 0
    eng.execute({"id": 2, "cmd": "mode", "value": "session"})
    eng.fast_tick()
    assert env.out.events[-1]["type"] == "context"


# -- ambient text ---------------------------------------------------------------------------

def test_text_snapshot_delta_and_sensitive_blur(env):
    erp(env.backend)
    env.backend.walks[1] = WalkResult(items=[
        WalkItem("Text", "Invoice 4471", None, False, {"rect": (40, 120, 300, 150)}),
        WalkItem("Edit", "Notes", "card 4242 4242 4242 4242", False, {"rect": (100, 600, 500, 625)}),
    ])
    eng = env.build(mode="session")
    eng.fast_tick()
    eng.slow_tick()
    assert not env.out.of("text")  # settle time first
    env.clock.tick(1.1)
    eng.slow_tick()
    [t] = env.out.of("text")
    assert t["key"] == "browser:minierp.local" and t["delta"] == ["Invoice 4471", "Notes", "card [CARD ••••4242]"]
    env.clock.tick(16)
    eng.on_hook(HookEvent("typing", env.clock.t))
    eng.slow_tick()
    assert len(env.out.of("text")) == 1  # nothing new
    # The masked Notes field is blurred in the next screenshot.
    click(eng, 800, 440, env.clock.tick(0.1))
    shot = env.out.of("click")[-1]["shot"]
    img = Image.open(env.data / shot).convert("L")
    assert ImageStat.Stat(img.crop((110, 603, 490, 622))).stddev[0] < ImageStat.Stat(img.crop((110, 653, 490, 672))).stddev[0] * 0.3


def test_first_click_in_new_window_already_blurs_masked_fields(env):
    """No text snapshot has run yet: the click must trigger a quick scan before the shot is saved."""
    erp(env.backend)
    env.backend.walks[1] = WalkResult(items=[
        WalkItem("Edit", "Notes", "Pay to DE89 3704 0044 0532 0130 00", False, {"rect": (100, 600, 500, 625)}),
    ])
    eng = env.build(mode="session")
    click(eng, 800, 440, env.clock.tick(0.01))  # before any fast_tick / slow_tick
    shot = env.out.of("click")[-1]["shot"]
    img = Image.open(env.data / shot).convert("L")
    assert ImageStat.Stat(img.crop((110, 603, 490, 622))).stddev[0] < ImageStat.Stat(img.crop((110, 653, 490, 672))).stddev[0] * 0.3
    assert not env.out.of("text")  # the quick scan never emits text


def test_text_discarded_if_window_changes_during_walk(env):
    erp(env.backend)
    env.backend.walks[1] = WalkResult(items=[WalkItem("Text", "Invoice 4471", None, False)])
    eng = env.build()
    eng.fast_tick()
    env.clock.tick(1.1)

    def switch():
        env.backend.urls[1] = "secure.chase.com"
    env.backend.on_walk = switch
    eng.slow_tick()
    assert not env.out.of("text")


# -- accessibility health ------------------------------------------------------------------------

def test_blind_app_prompt_once_then_vision_mode(env):
    legacy = make_window(hwnd=5, pid=500, process="legacy.exe", title="Legacy ERP", class_name="TForm",
                         rect=(0, 0, 800, 600))
    env.backend.add_window(legacy, walk=WalkResult(items=[WalkItem("Pane", "", None, False)]))
    eng = env.build(mode="session")
    for _ in range(50):  # ~25 s of active use
        env.clock.tick(0.5)
        eng.on_hook(HookEvent("move", env.clock.t, x=5, y=5))
        eng.fast_tick()
        eng.slow_tick()
    [h] = env.out.of("a11y_health")
    assert h["status"] == "blind" and h["prompt"] is True and h["key"] == "legacy.exe"
    assert env.store.app_mode("legacy.exe")["a11y_prompted_at"]
    reply = eng.execute({"id": 3, "cmd": "a11y_ack", "key": "legacy.exe", "choice": "yes"})
    assert reply["ok"]
    eng.fast_tick()
    assert env.out.of("context")[-1]["capture"] == "vision"
    click(eng, 100, 100, env.clock.tick(0.1))
    c = env.out.of("click")[-1]
    assert c["target"] is None and c["shot"] and c["shot_meta"]["auto_blur"] is False


def test_never_blocks_the_app(env):
    legacy = make_window(hwnd=5, pid=500, process="legacy.exe", title="Legacy ERP", class_name="TForm")
    env.backend.add_window(legacy)
    eng = env.build()
    eng.fast_tick()
    eng.execute({"id": 4, "cmd": "a11y_ack", "key": "legacy.exe", "choice": "never"})
    eng.fast_tick()
    assert env.out.events[-1] == {"type": "blocked", "t": env.clock.t, "reason": "user_blocked"}
    assert "legacy.exe" in env.store.privacy["blocked_apps"]
    assert env.store.app_mode("legacy.exe")["never_ask"] is True


def test_remote_session_reported_blind_at_once(env):
    env.backend.add_window(make_window(hwnd=6, pid=600, process="mstsc.exe", title="Remote Desktop", class_name="TscShellContainerClass"))
    eng = env.build()
    eng.fast_tick()
    [h] = env.out.of("a11y_health")
    assert h["status"] == "blind" and h["hint"] == "remote_session" and h["prompt"] is True


def test_chromium_empty_document_hint(env):
    erp(env.backend)
    env.backend.walks[1] = WalkResult(items=[WalkItem("Text", f"label {i} with some text", None, False) for i in range(20)])
    env.backend.web_empty[1] = True
    eng = env.build()
    for _ in range(60):
        env.clock.tick(0.5)
        eng.on_hook(HookEvent("move", env.clock.t, x=5, y=5))
        eng.fast_tick()
        eng.slow_tick()
    blind = [h for h in env.out.of("a11y_health") if h["status"] == "blind"]
    assert blind and blind[0]["hint"] == "chromium_flag" and "web document has no children" in blind[0]["reasons"]


# -- app scaling ------------------------------------------------------------------------------------

def test_scaling_correction_saved_and_applied(env):
    old = make_window(hwnd=7, pid=700, process="OLDAPP.EXE", title="Old app", class_name="Afx", rect=(0, 0, 1900, 1000),
                      monitor_scale=1.5, dpi_awareness="unaware", window_dpi=96)
    els = []
    for i, (x, y) in enumerate([(300, 300), (600, 450), (900, 150), (150, 600)]):
        lx, ly = round(x / 1.5), round(y / 1.5)
        el = element(f"Button {i}", "Button", (lx - 10, ly - 10, lx + 10, ly + 10), pid=700)
        els.append(el)
        env.backend.hits[(x, y)] = el  # UIA finds the element, but reports a logical rect
    env.backend.add_window(old, elements=els)
    eng = env.build()
    eng.fast_tick()
    for x, y in [(300, 300), (600, 450), (900, 150)]:
        click(eng, x, y, env.clock.tick(0.2))
    [s] = env.out.of("app_scaling")
    assert s == {"type": "app_scaling", "t": s["t"], "key": "oldapp.exe", "status": "corrected", "rect_scale": 1.5, "rect_anchor": "screen"}
    assert env.store.app_mode("oldapp.exe")["rect_scale"] == 1.5
    click(eng, 150, 600, env.clock.tick(0.2))
    last = env.out.of("click")[-1]["target"]
    assert last["rect_trusted"] and last["rect"] == [135, 585, 165, 615]
    reply = eng.execute({"id": 5, "cmd": "tree", "max": 10})
    assert reply["ok"] and reply["controls"][0]["rect"] == [285, 285, 315, 315]


def test_saved_correction_loaded_on_start(env):
    env.store.update_app_mode("oldapp.exe", rect_scale=1.5, rect_anchor="screen")
    old = make_window(hwnd=7, pid=700, process="oldapp.exe", title="Old", class_name="Afx", rect=(0, 0, 1900, 1000), monitor_scale=1.5)
    ok = element("OK", "Button", (190, 190, 210, 210), pid=700)
    env.backend.add_window(old, elements=[ok])
    env.backend.hits[(300, 300)] = ok
    eng = env.build()
    eng.fast_tick()
    click(eng, 300, 300, env.clock.tick(0.2))
    t = env.out.of("click")[-1]["target"]
    assert t["rect"] == [285, 285, 315, 315] and t["rect_trusted"]


# -- periodic screenshots ------------------------------------------------------------------------------

def test_session_heartbeat_only_when_screen_changes(env):
    erp(env.backend)
    eng = env.build(mode="session")
    eng.fast_tick()
    eng.slow_tick()
    [s1] = env.out.of("shot")
    assert s1["reason"] == "heartbeat" and s1["ephemeral"] is False and (env.data / s1["path"]).exists()
    env.clock.tick(5.1); eng.slow_tick()
    assert len(env.out.of("shot")) == 1  # unchanged screen
    env.backend.frame += 1
    env.clock.tick(5.1); eng.slow_tick()
    assert len(env.out.of("shot")) == 2


def test_tutor_heartbeats_are_ephemeral(env):
    erp(env.backend)
    eng = env.build(mode="tutor")
    eng.fast_tick()
    eng.slow_tick()
    [s] = env.out.of("shot")
    assert s["ephemeral"] is True and s["path"].startswith("shots/tmp/")


def test_ambient_shots_are_small_ephemeral_and_can_be_disabled(env):
    erp(env.backend)
    eng = env.build(mode="ambient")
    eng.fast_tick()
    eng.slow_tick()
    [s] = env.out.of("shot")
    assert s["reason"] == "ambient" and s["ephemeral"] and Image.open(env.data / s["path"]).size[0] == 960
    assert s["meta"]["scale"] == 0.75
    env.store.privacy["ambient_screenshots"] = False
    env.backend.frame += 3
    env.clock.tick(61); eng.slow_tick()
    assert len(env.out.of("shot")) == 1


# -- commands ---------------------------------------------------------------------------------------------

def test_redact_command(env):
    eng = env.build()
    assert eng.execute({"id": 9, "cmd": "redact", "text": "SSN 123-45-6789"}) == {"id": 9, "ok": True, "text": "SSN [SSN]"}


def test_tree_and_shot_refused_when_blocked(env):
    env.backend.add_window(make_window(process="1password.exe", title="1Password"))
    eng = env.build()
    eng.fast_tick()
    assert eng.execute({"id": 1, "cmd": "tree", "max": 5}) == {"id": 1, "ok": False, "error": "blocked"}
    assert eng.execute({"id": 2, "cmd": "shot", "reason": "on_demand"}) == {"id": 2, "ok": False, "error": "blocked"}


def test_tree_redacts_names_and_shot_saves_tmp(env):
    erp(env.backend)
    env.backend.elements[1].append(element("Acct DE89 3704 0044 0532 0130 00", "Text", (10, 10, 300, 30)))
    eng = env.build()
    eng.fast_tick()
    tree = eng.execute({"id": 1, "cmd": "tree", "max": 50})
    names = [c["name"] for c in tree["controls"]]
    assert "Acct [IBAN ••••3000]" in names and "Post" in names
    shot = eng.execute({"id": 2, "cmd": "shot", "reason": "on_demand"})
    assert shot["ok"] and shot["path"].startswith("shots/tmp/") and shot["meta"]["auto_blur"] is True
    assert not env.out.of("shot")  # on-demand shots are replies, not events


def test_set_capture_and_reload_config(env):
    erp(env.backend)
    eng = env.build()
    eng.fast_tick()
    assert eng.execute({"id": 1, "cmd": "set_capture", "key": "browser:minierp.local", "value": "vision"})["ok"]
    eng.fast_tick()
    assert env.out.of("context")[-1]["capture"] == "vision"
    privacy = json.loads(env.store.privacy_path.read_text(encoding="utf-8"))
    privacy["blocked_domains"] = ["minierp.local"]
    env.store.privacy_path.write_text(json.dumps(privacy), encoding="utf-8")
    assert eng.execute({"id": 2, "cmd": "reload_config"})["ok"]
    eng.fast_tick()
    assert env.out.events[-1]["type"] == "blocked" and env.out.events[-1]["reason"] == "user_blocked"


def test_command_errors_are_replies_not_crashes(env):
    eng = env.build()
    env.backend.tree = None  # break the backend
    erp(env.backend)
    eng.fast_tick()
    r = eng.execute({"id": 1, "cmd": "tree", "max": 5})
    assert r["ok"] is False and "TypeError" in r["error"]


# -- activity, keys, watchdog, displays -------------------------------------------------------------------

def test_activity_is_throttled(env):
    erp(env.backend)
    eng = env.build()
    eng.fast_tick()
    for i in range(10):
        eng.on_hook(HookEvent("typing", env.clock.tick(0.1)))
    assert len(env.out.of("activity")) == 2


def test_watchdog_restarts_silent_hooks_once_per_minute(env):
    erp(env.backend)
    eng = env.build()
    env.backend.idle = 0.5
    env.clock.tick(6)
    eng.fast_tick()
    assert env.backend.restarts == 1 and env.out.of("warning")[-1]["code"] == "hook_restarted"
    env.clock.tick(3)
    eng.fast_tick()
    assert env.backend.restarts == 1
    eng.on_hook(HookEvent("move", env.clock.t, x=1, y=1))  # hooks alive again
    env.clock.tick(2.1)
    eng.fast_tick()
    assert env.backend.restarts == 1


def test_displays_change_is_reported(env):
    eng = env.build()
    env.backend.monitor_list.append(MonitorInfo(2, (1920, 0, 4800, 1620), (1920, 0, 4800, 1560), 144, 1.5, False))
    env.clock.tick(5.1)
    eng.slow_tick()
    d = env.out.of("displays")[-1]
    assert len(d["monitors"]) == 2 and d["monitors"][1]["scale"] == 1.5


def test_popup_is_included_in_capture_region(env):
    erp(env.backend, popup_rect=(600, 700, 900, 1000))
    eng = env.build(mode="session")
    eng.fast_tick()
    click(eng, 800, 440, env.clock.tick(0.1))
    assert env.out.of("click")[-1]["shot_meta"]["size_px"] == [1280, 1000]


def test_all_events_match_contract_types(env):
    """Every emitted event type is one of the SidecarEvent types in shared/contracts.ts."""
    contracts = (Path(__file__).resolve().parents[2] / "shared" / "contracts.ts").read_text(encoding="utf-8")
    erp(env.backend)
    env.backend.walks[1] = WalkResult(items=[WalkItem("Text", "Invoice 4471", None, False)])
    eng = env.build(mode="session")
    for _ in range(10):
        env.clock.tick(0.5)
        eng.on_hook(HookEvent("typing", env.clock.t))
        eng.fast_tick()
        eng.slow_tick()
    click(eng, 800, 440, env.clock.tick(0.1))
    kinds = {e["type"] for e in env.out.events}
    assert kinds >= {"ready", "displays", "context", "activity", "text", "shot", "click"}
    for k in kinds:
        assert f"type: '{k}'" in contracts, k


def test_hung_app_is_reported_once_a_minute(env):
    import time as _time
    erp(env.backend)
    eng = env.build()
    eng.fast_tick()
    real = env.backend.focused

    def slow_focus(tracked):
        _time.sleep(0.05)
        return real(tracked)
    env.backend.focused = slow_focus
    eng.SLOW_FAST_STEP_S = 0.01  # make the test fast
    env.clock.tick(0.4)
    eng.fast_tick()
    env.clock.tick(0.4)
    eng.fast_tick()
    warns = [w for w in env.out.of("warning") if w["code"] == "uia_timeout"]
    assert len(warns) == 1 and "not be responding" in warns[0]["detail"]
