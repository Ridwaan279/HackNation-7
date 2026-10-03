"""Screenshot post-processing: highlight, blur, downscale, change detection, save.

Captures are taken in physical pixels. Highlights and blurs are drawn at full
resolution, then the image is downscaled. ShotMeta records how to map image
pixels back to the screen: screen_px = origin_px + image_px / scale.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Iterable, Optional, Tuple

from PIL import Image, ImageChops, ImageDraw, ImageStat

from model import Rect

MAX_EDGE = 1600  # step / heartbeat screenshots
AMBIENT_WIDTH = 960  # ambient screenshots
JPEG_QUALITY = 80
TMP_MAX_AGE_S = 600  # ephemeral files left behind are deleted after 10 minutes
SIG_SIZE = (64, 36)
CHANGE_THRESHOLD = 2.0  # mean absolute difference (0-255): ~2% of the window changing visibly

HIGHLIGHT = (245, 70, 190)
OUTLINE = (255, 255, 255)


def intersect(a: Rect, b: Rect) -> Optional[Rect]:
    l, t, r, btm = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    return (l, t, r, btm) if r > l and btm > t else None


def union(rects: Iterable[Rect]) -> Optional[Rect]:
    rs = list(rects)
    if not rs:
        return None
    return (min(r[0] for r in rs), min(r[1] for r in rs), max(r[2] for r in rs), max(r[3] for r in rs))


def _to_image(rect: Rect, origin: Tuple[int, int]) -> Rect:
    return (rect[0] - origin[0], rect[1] - origin[1], rect[2] - origin[0], rect[3] - origin[1])


def blur_rects(img: Image.Image, origin: Tuple[int, int], rects: Iterable[Optional[Rect]]) -> int:
    """Irreversibly smear each rect (box-downsample to 1/16, scale back up). Returns how many were blurred."""
    count = 0
    bounds = (0, 0, img.width, img.height)
    for rect in rects:
        if not rect:
            continue
        box = intersect(_to_image(rect, origin), bounds)
        if not box:
            continue
        region = img.crop(box)
        w, h = region.size
        small = region.resize((max(1, w // 16), max(1, h // 16)), Image.Resampling.BOX)
        img.paste(small.resize((w, h), Image.Resampling.BILINEAR), box[:2])
        count += 1
    return count


def annotate(img: Image.Image, origin: Tuple[int, int], click: Optional[Tuple[int, int]],
             target: Optional[Rect]) -> None:
    """Box around the clicked element and a ring at the click point (in place)."""
    draw = ImageDraw.Draw(img)
    width = max(2, round(min(img.width, img.height) / 400))
    if target:
        l, t, r, b = _to_image(target, origin)
        draw.rectangle((l - 1, t - 1, r + 1, b + 1), outline=OUTLINE, width=width + 2)
        draw.rectangle((l, t, r, b), outline=HIGHLIGHT, width=width)
    if click:
        cx, cy = click[0] - origin[0], click[1] - origin[1]
        radius = max(14, width * 8)
        draw.ellipse((cx - radius - 1, cy - radius - 1, cx + radius + 1, cy + radius + 1), outline=OUTLINE, width=width + 2)
        draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), outline=HIGHLIGHT, width=width)


def downscale(img: Image.Image, max_edge: Optional[int] = None, width: Optional[int] = None) -> Tuple[Image.Image, float]:
    """Return (image, scale) where scale = new size / original size (<= 1)."""
    w, h = img.size
    scale = 1.0
    if width and w > width:
        scale = width / w
    elif max_edge and max(w, h) > max_edge:
        scale = max_edge / max(w, h)
    if scale >= 1.0:
        return img, 1.0
    new = (max(1, round(w * scale)), max(1, round(h * scale)))
    return img.resize(new, Image.Resampling.LANCZOS), new[0] / w


def signature(img: Image.Image) -> Image.Image:
    return img.convert("L").resize(SIG_SIZE, Image.Resampling.BILINEAR)


def changed(a: Optional[Image.Image], b: Optional[Image.Image], threshold: float = CHANGE_THRESHOLD) -> bool:
    if a is None or b is None:
        return True
    return ImageStat.Stat(ImageChops.difference(a, b)).mean[0] > threshold


def shot_meta(origin: Tuple[int, int], size: Tuple[int, int], scale: float, monitor: int, auto_blur: bool) -> dict:
    return {"origin_px": [int(origin[0]), int(origin[1])], "size_px": [int(size[0]), int(size[1])],
            "scale": round(scale, 6), "monitor": int(monitor), "auto_blur": bool(auto_blur)}


def save_jpeg(img: Image.Image, data_dir: Path, t: float, ephemeral: bool) -> str:
    """Save under <data_dir>/shots/<date>/ (kept) or shots/tmp/ (ephemeral).

    Returns the path relative to data_dir with forward slashes, e.g. "shots/2026-10-04/1727980012400.jpg".
    """
    sub = "tmp" if ephemeral else time.strftime("%Y-%m-%d", time.localtime(t))
    folder = Path(data_dir) / "shots" / sub
    folder.mkdir(parents=True, exist_ok=True)
    stem = str(int(t * 1000))
    path = folder / f"{stem}.jpg"
    n = 1
    while path.exists():
        path = folder / f"{stem}-{n}.jpg"
        n += 1
    img.convert("RGB").save(path, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return path.relative_to(Path(data_dir)).as_posix()


def janitor(data_dir: Path, now: Optional[float] = None, max_age_s: float = TMP_MAX_AGE_S) -> int:
    """Delete ephemeral screenshots older than max_age_s (safety net if nobody deleted them)."""
    folder = Path(data_dir) / "shots" / "tmp"
    if not folder.is_dir():
        return 0
    now = time.time() if now is None else now
    removed = 0
    for p in folder.iterdir():
        try:
            if p.is_file() and now - p.stat().st_mtime > max_age_s:
                p.unlink()
                removed += 1
        except OSError:
            pass
    return removed
