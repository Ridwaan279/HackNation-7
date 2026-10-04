import time

import pytest
from PIL import Image, ImageStat

import shots
from commit import CommitTracker, trackable
from health import HealthTracker
from model import FocusInfo, WalkItem
from redact import Redactor
from scaling import ScalingTracker, apply_scale, rect_contains
from textsnap import MAX_DELTA_BYTES, TextSnapshotter, classify


def focus(value, key=("f", 1), name="Cost center", ctype="Edit", is_password=False, rect=(0, 0, 10, 10)):
    return FocusInfo(key=key, name=name, control_type=ctype, automation_id="", value=value,
                     is_password=is_password, rect=rect, pid=100)


# -- commits ------------------------------------------------------------------------

def test_commit_on_idle_then_no_duplicate_on_blur():
    c = CommitTracker()
    assert c.observe(focus("4711"), 0.0) == []
    assert c.observe(focus("0400"), 0.3) == []
    assert c.observe(focus("0400"), 0.6) == []          # only 0.3 s idle
    [idle] = c.observe(focus("0400"), 1.2)               # 0.9 s idle
    assert (idle.old, idle.new, idle.final) == ("4711", "0400", False)
    assert c.observe(None, 2.0) == []                    # blur: nothing new since the commit


def test_commit_on_blur_is_final():
    c = CommitTracker()
    c.observe(focus("a"), 0.0)
    c.observe(focus("ab"), 0.1)
    [final] = c.observe(focus("x", key=("f", 2), name="Amount"), 0.2)
    assert (final.field, final.old, final.new, final.final) == ("Cost center", "a", "ab", True)


def test_flush_final_on_enter():
    c = CommitTracker()
    c.observe(focus("1"), 0.0)
    [f] = c.flush_final(focus("12"), 0.1)
    assert (f.old, f.new, f.final) == ("1", "12", True)
    assert c.flush_final(focus("12"), 0.2) == []


def test_unchanged_field_never_commits():
    c = CommitTracker()
    c.observe(focus("same"), 0.0)
    assert c.observe(focus("same"), 5.0) == []
    assert c.observe(None, 6.0) == []


def test_password_and_untracked_fields_are_ignored():
    c = CommitTracker()
    assert not trackable(focus(None, is_password=True))
    assert not trackable(focus("x", name="Password"))
    assert not trackable(focus("x", ctype="Button"))
    assert not trackable(focus(None))
    c.observe(focus("secret1", name="PIN"), 0.0)
    assert c.observe(focus("secret12", name="PIN"), 2.0) == []


def test_reset_drops_pending_value():
    c = CommitTracker()
    c.observe(focus("a"), 0.0)
    c.observe(focus("abc"), 0.1)
    c.reset()
    assert c.observe(None, 1.0) == []


# -- text snapshots -----------------------------------------------------------------

def test_delta_dedupe_and_masking():
    t = TextSnapshotter(Redactor())
    items = [WalkItem("Text", "Invoice 4471", None, False, "h1"),
             WalkItem("Edit", "Notes", "card 4242 4242 4242 4242", False, "h2"),
             WalkItem("Edit", "Password", "hunter2", True, "h3")]
    r1 = t.process("w", items, None)
    assert r1.delta == ["Invoice 4471", "Notes", "card [CARD ••••4242]", "Password"]
    assert set(r1.sensitive) == {"h2", "h3"}
    assert "hunter2" not in " ".join(r1.delta)
    r2 = t.process("w", items + [WalkItem("Text", "Status: held", None, False, None)], None)
    assert r2.delta == ["Status: held"]


def test_password_like_edit_value_is_never_read():
    t = TextSnapshotter(Redactor())
    r = t.process("w", [WalkItem("Edit", "PIN", "4821", False, "h")], None)
    assert r.delta == ["PIN"] and r.sensitive == ["h"]


def test_doc_text_capped_and_delta_size_capped():
    t = TextSnapshotter(Redactor())
    doc = "\n".join(f"line {i} " + "x" * 50 for i in range(200))
    r = t.process("w", [], doc)
    assert sum(len(l) for l in r.delta) <= 1100
    big = [WalkItem("Text", f"row {i} " + "y" * 280, None, False, None) for i in range(40)]
    r2 = t.process("w2", big, None)
    assert sum(len(l.encode()) + 1 for l in r2.delta) <= MAX_DELTA_BYTES
    # Lines that didn't fit are not marked as seen, so the next snapshot emits them.
    r3 = t.process("w2", big, None)
    assert r3.delta and not set(r3.delta) & set(r2.delta)


def test_stats_and_noise_filtering():
    t = TextSnapshotter(Redactor())
    r = t.process("w", [WalkItem("Text", "  ", None, False, None), WalkItem("Text", "—", None, False, None),
                        WalkItem("Button", "Post", None, False, None)], None)
    assert r.delta == ["Post"] and r.named_elements == 2


# -- health -----------------------------------------------------------------------------

def test_no_verdict_before_20s_of_use():
    h = HealthTracker()
    h.note_snapshot("app", 1, 0)
    h.note_active("app", 10)
    assert h.evaluate("app") is None


def test_blind_then_ok_after_better_evidence():
    h = HealthTracker()
    h.note_active("app", 25)
    h.note_snapshot("app", 2, 10)
    ev = h.evaluate("app")
    assert ev["status"] == "blind" and ev["hint"] == "none" and len(ev["reasons"]) == 2
    assert h.evaluate("app") is None  # unchanged status is not re-reported
    h.note_snapshot("app", 40, 900)
    assert h.evaluate("app")["status"] == "ok"


def test_weak_and_click_resolution():
    h = HealthTracker()
    h.note_active("app", 25)
    h.note_snapshot("app", 10, 500)
    assert h.evaluate("app")["status"] == "weak"
    h2 = HealthTracker()
    h2.note_active("b", 25)
    h2.note_snapshot("b", 40, 900)
    for ok in (False, False, False, True):
        h2.note_click("b", ok)
    ev = h2.evaluate("b")
    assert ev["status"] == "blind" and ev["score"]["click_resolution"] == 0.25


def test_remote_session_blind_immediately():
    h = HealthTracker()
    h.note_remote("mstsc.exe")
    ev = h.evaluate("mstsc.exe")
    assert ev["status"] == "blind" and ev["hint"] == "remote_session"


def test_web_document_must_be_empty_twice_2s_apart():
    h = HealthTracker()
    h.note_active("browser:x", 25)
    h.note_snapshot("browser:x", 40, 900)
    h.note_web_document("browser:x", True, 100.0)
    assert h.evaluate("browser:x")["status"] == "ok"
    h.note_web_document("browser:x", True, 101.0)
    assert h.evaluate("browser:x") is None
    h.note_web_document("browser:x", True, 102.5)
    ev = h.evaluate("browser:x")
    assert ev["status"] == "blind" and ev["hint"] == "chromium_flag"
    h.note_web_document("browser:x", False, 110.0)
    assert h.evaluate("browser:x")["status"] == "ok"


# -- scaling ------------------------------------------------------------------------------

def test_well_behaved_app_stays_ok():
    s = ScalingTracker()
    for i in range(6):
        r = s.check("app", 105, 105, (100, 100, 200, 130), 1.5, (0, 0))
        assert r.trusted and r.event is None
    assert s.status("app") == "ok"


def test_logical_rects_get_corrected_screen_anchor():
    s = ScalingTracker()
    clicks = [(300, 300), (600, 450), (900, 150), (150, 600)]
    events = []
    for x, y in clicks:
        logical = (round(x / 1.5) - 10, round(y / 1.5) - 10, round(x / 1.5) + 10, round(y / 1.5) + 10)
        res = s.check("old.exe", x, y, logical, 1.5, (0, 0))
        events.append(res.event)
    corrected = [e for e in events if e]
    assert corrected[-1] == {"key": "old.exe", "status": "corrected", "rect_scale": 1.5, "rect_anchor": "screen"}
    assert s.status("old.exe") == "corrected"
    assert res.trusted  # the click that triggered the correction is now inside
    assert s.correct("old.exe", (100, 100, 110, 110), (0, 0)) == (150, 150, 165, 165)


def test_monitor_anchor_on_secondary_monitor():
    s = ScalingTracker()
    origin = (1920, 0)
    for x, y in [(2300, 300), (2700, 500), (3100, 200)]:
        lx, ly = origin[0] + (x - origin[0]) / 1.5, origin[1] + (y - origin[1]) / 1.5
        res = s.check("qt.exe", x, y, (round(lx) - 8, round(ly) - 8, round(lx) + 8, round(ly) + 8), 1.5, origin)
    assert res.event and res.event["rect_anchor"] == "monitor" and res.event["rect_scale"] == 1.5


def test_untrusted_when_nothing_fits_and_recovery():
    s = ScalingTracker()
    for x, y in [(500, 500), (700, 300), (900, 700)]:
        res = s.check("weird.exe", x, y, (10, 10, 20, 20), 1.5, (0, 0))
    assert res.event == {"key": "weird.exe", "status": "untrusted"} and not res.trusted
    for _ in range(5):
        res = s.check("weird.exe", 15, 15, (10, 10, 20, 20), 1.5, (0, 0))
    assert res.event == {"key": "weird.exe", "status": "ok"}


def test_correction_dropped_when_app_moves_to_100_percent():
    s = ScalingTracker()
    s.set_correction("app", 1.5, "screen")
    events = [s.check("app", x, y, (x - 5, y - 5, x + 5, y + 5), 1.0, (0, 0)).event for x, y in [(100, 100), (200, 200), (300, 300)]]
    assert events[-1] == {"key": "app", "status": "ok"}
    assert s.correct("app", (1, 1, 2, 2), (0, 0)) == (1, 1, 2, 2)


def test_empty_rects_are_not_checked():
    assert ScalingTracker().check("a", 1, 1, (0, 0, 0, 0), 1.5, (0, 0)) is None
    assert ScalingTracker().check("a", 1, 1, None, 1.5, (0, 0)) is None


def test_geometry_helpers():
    assert rect_contains((0, 0, 10, 10), 11, 11) and not rect_contains((0, 0, 10, 10), 13, 5)
    assert apply_scale((10, 10, 20, 20), 2.0, (10, 10)) == (10, 10, 30, 30)


# -- screenshots ----------------------------------------------------------------------------

def stripes(w=400, h=200):
    img = Image.new("RGB", (w, h), "white")
    px = img.load()
    for y in range(0, h, 2):
        for x in range(w):
            px[x, y] = (0, 0, 0)
    return img


def stddev(img, box):
    return ImageStat.Stat(img.crop(box).convert("L")).stddev[0]


def test_blur_destroys_detail_only_inside_rect():
    img = stripes()
    before_in, before_out = stddev(img, (50, 50, 150, 80)), stddev(img, (250, 50, 350, 80))
    n = shots.blur_rects(img, (1000, 500), [(1050, 550, 1150, 580), None, (5000, 5000, 5010, 5010)])
    assert n == 1
    assert stddev(img, (50, 50, 150, 80)) < before_in * 0.2
    assert stddev(img, (250, 50, 350, 80)) == pytest.approx(before_out)


def test_annotate_draws_box_and_ring():
    white = (255, 255, 255)
    img = Image.new("RGB", (300, 300), "white")
    # Screen coords with origin (100, 100): box -> image (10,10)-(90,60), click -> image (150,150).
    shots.annotate(img, (100, 100), (250, 250), (110, 110, 190, 160))
    assert img.getpixel((10, 35)) == shots.HIGHLIGHT       # left edge of the box
    assert img.getpixel((50, 35)) == white                 # inside the box stays clean
    assert img.getpixel((150 + 16, 150)) != white          # ring (radius 16 at this size)
    assert img.getpixel((150, 150)) == white               # ring centre stays clean


def test_downscale_and_meta_mapping():
    img = Image.new("RGB", (3200, 1800))
    out, scale = shots.downscale(img, max_edge=1600)
    assert out.size == (1600, 900) and scale == 0.5
    meta = shots.shot_meta((100, 50), (3200, 1800), scale, 2, True)
    # image pixel (800, 450) -> screen 100 + 800/0.5 = 1700, 50 + 450/0.5 = 950
    assert meta["origin_px"][0] + 800 / meta["scale"] == 1700
    assert meta["origin_px"][1] + 450 / meta["scale"] == 950
    small, s2 = shots.downscale(Image.new("RGB", (800, 600)), max_edge=1600)
    assert s2 == 1.0 and small.size == (800, 600)
    amb, s3 = shots.downscale(Image.new("RGB", (1920, 1080)), width=960)
    assert amb.size == (960, 540) and s3 == 0.5


def test_change_detection():
    a = shots.signature(stripes())
    b = shots.signature(stripes())
    assert not shots.changed(a, b)
    img = stripes()
    img.paste((255, 0, 0), (0, 0, 200, 200))
    assert shots.changed(a, shots.signature(img))
    assert shots.changed(None, a)


def test_save_paths_and_janitor(tmp_path):
    img = Image.new("RGB", (10, 10))
    t = 1727980012.4
    kept = shots.save_jpeg(img, tmp_path, t, ephemeral=False)
    again = shots.save_jpeg(img, tmp_path, t, ephemeral=False)
    tmp = shots.save_jpeg(img, tmp_path, t, ephemeral=True)
    assert kept.startswith("shots/") and kept.endswith("/1727980012400.jpg") and "\\" not in kept
    assert again.endswith("1727980012400-1.jpg")
    assert tmp == "shots/tmp/1727980012400.jpg"
    assert (tmp_path / kept).exists() and (tmp_path / tmp).exists()
    assert shots.janitor(tmp_path, now=time.time()) == 0
    assert shots.janitor(tmp_path, now=time.time() + 601) == 1
    assert (tmp_path / kept).exists() and not (tmp_path / tmp).exists()


def test_rect_helpers():
    assert shots.intersect((0, 0, 10, 10), (5, 5, 20, 20)) == (5, 5, 10, 10)
    assert shots.intersect((0, 0, 10, 10), (10, 10, 20, 20)) is None
    assert shots.union([(0, 0, 1, 1), (5, 5, 6, 6)]) == (0, 0, 6, 6)
    assert shots.union([]) is None


def test_edited_iban_field_stays_masked_and_blurred():
    # Seen on Windows: typing into the IBAN broke its checksum, and the raw value went out.
    items = [WalkItem("Edit", "Notes", "Pay to DE89 3704 0044 0532 0130 ff00", False, "notes")]
    lines, sensitive, _ = classify(items, Redactor())
    assert lines == ["Notes", "Pay to [IBAN]"] and sensitive == ["notes"]
