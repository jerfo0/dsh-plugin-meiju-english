#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate original Friends-inspired posters for the Meiju English Learning plugin.

Everything is drawn from scratch with Pillow primitives -- no copyrighted image,
no network access, no random values (identical output on every run).

Usage:
    python tools/posters.py --catalog data/catalog.json --out data/posters

Outputs:
    <out>/show.jpg              600x900 series poster
    <out>/s01e01.jpg ...         300x450 episode posters (one per catalog episode)
"""

import argparse
import colorsys
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------- palette ----
CREAM = (245, 230, 211)     # #F5E6D3
ESPRESSO = (43, 27, 18)     # #2B1B12
ORANGE = (228, 87, 46)      # #E4572E
MUSTARD = (242, 193, 78)    # #F2C14E

FONT_DIR = r"C:\Windows\Fonts"
CN_FONT_CANDIDATES = [
    os.path.join(FONT_DIR, "msyhbd.ttc"),
    os.path.join(FONT_DIR, "msyh.ttc"),
    os.path.join(FONT_DIR, "simhei.ttf"),
    os.path.join(FONT_DIR, "simsun.ttc"),
    os.path.join(FONT_DIR, "msyhl.ttc"),
    r"C:\Windows\Fonts\msjhbd.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
]
LATIN_FONT_CANDIDATES = [
    os.path.join(FONT_DIR, "arialbd.ttf"),
    os.path.join(FONT_DIR, "gb.ttf"),
    os.path.join(FONT_DIR, "segoeuib.ttf"),
    os.path.join(FONT_DIR, "arial.ttf"),
    os.path.join(FONT_DIR, "segoeui.ttf"),
    os.path.join(FONT_DIR, "calibrib.ttf"),
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]

_FONT_CACHE = {}


# ------------------------------------------------------------- font utils ----
def load_font(candidates, size):
    """Return a font of roughly `size` px, never raising on a missing file."""
    key = (tuple(candidates), int(size))
    cached = _FONT_CACHE.get(key)
    if cached is not None:
        return cached
    font = None
    for path in candidates:
        if not path or not os.path.isfile(path):
            continue
        try:
            font = ImageFont.truetype(path, int(size))
            break
        except Exception:
            font = None
    if font is None:
        try:
            font = ImageFont.load_default(size=int(size))
        except Exception:
            try:
                font = ImageFont.load_default()
            except Exception:
                font = None
    _FONT_CACHE[key] = font
    return font


def text_size(draw, text, font):
    """(width, height, offset_x, offset_y) of a text string."""
    if font is None or not text:
        return (0, 0, 0, 0)
    try:
        box = draw.textbbox((0, 0), text, font=font)
        return (box[2] - box[0], box[3] - box[1], box[0], box[1])
    except Exception:
        try:
            w, h = font.getsize(text)
            return (w, h, 0, 0)
        except Exception:
            return (len(text) * 8, 12, 0, 0)


def draw_text_center(draw, cx, cy, text, font, fill):
    """Draw text centered on (cx, cy) without relying on anchor support."""
    if not text or font is None:
        return
    w, h, ox, oy = text_size(draw, text, font)
    draw.text((int(cx - w / 2.0 - ox), int(cy - h / 2.0 - oy)), text,
              font=font, fill=fill)


def draw_text_baseline(draw, x, baseline, text, font, fill):
    """Draw text with its left edge at x and its baseline at `baseline`."""
    if not text or font is None:
        return
    try:
        draw.text((int(x), int(baseline)), text, font=font, fill=fill, anchor="ls")
    except Exception:
        w, h, ox, oy = text_size(draw, text, font)
        draw.text((int(x - ox), int(baseline - oy - h)), text, font=font, fill=fill)


def fit_font(draw, text, candidates, start_size, max_width, min_size=8):
    """Largest font (<= start_size) whose rendering of `text` fits max_width."""
    size = int(start_size)
    while size > min_size:
        font = load_font(candidates, size)
        w = text_size(draw, text, font)[0]
        if w <= max_width:
            return font
        size -= 1
    return load_font(candidates, min_size)


def fit_lines(draw, lines, candidates, start_size, max_width, max_height,
              min_size=8, line_ratio=1.34):
    """Pick a font size so every line fits max_width and all lines fit max_height."""
    size = int(start_size)
    while size > min_size:
        font = load_font(candidates, size)
        widest = max((text_size(draw, ln, font)[0] for ln in lines), default=0)
        line_h = int(size * line_ratio)
        if widest <= max_width and line_h * len(lines) <= max_height:
            return font, line_h
        size -= 1
    return load_font(candidates, min_size), int(min_size * line_ratio)


def wrap_cjk(text, max_chars=12, max_lines=3):
    """Split a Chinese title into <= max_lines chunks of <= max_chars characters."""
    text = "".join(str(text or "").split())
    if not text:
        return [""]
    if len(text) <= max_chars:
        return [text]
    chunk = min(max_chars, max(1, -(-len(text) // max_lines)))
    lines = [text[i:i + chunk] for i in range(0, len(text), chunk)]
    if len(lines) > max_lines:
        head = lines[:max_lines - 1]
        tail = "".join(lines[max_lines - 1:])
        lines = head + [tail]
    return lines


def wrap_latin(draw, text, font, max_width, max_lines=2):
    """Greedy word wrap for an English line."""
    words = str(text or "").split()
    if not words:
        return [""]
    lines = []
    current = ""
    for word in words:
        trial = (current + " " + word).strip()
        if text_size(draw, trial, font)[0] <= max_width or not current:
            current = trial
        else:
            lines.append(current)
            current = word
    lines.append(current)
    while len(lines) > max_lines and len(lines) > 1:
        lines[-2] = lines[-2] + " " + lines[-1]
        lines.pop()
    return lines


# ----------------------------------------------------------- color helpers ----
def shift_color(rgb, dh=0.0, ds=0.0, dv=0.0):
    """Shift a color in HSV space (dh in turns, ds/dv in 0..1 units)."""
    r, g, b = (c / 255.0 for c in rgb)
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    r, g, b = colorsys.hsv_to_rgb((h + dh) % 1.0,
                                  max(0.0, min(1.0, s + ds)),
                                  max(0.0, min(1.0, v + dv)))
    return (int(round(r * 255)), int(round(g * 255)), int(round(b * 255)))


def lerp_color(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def episode_palette(number):
    """Deterministic per-episode hue variation of the warm Friends palette."""
    number = int(number or 1)
    dh = (((number * 53) % 21) - 10) / 360.0
    return {
        "bg_top": shift_color(CREAM, dh * 0.35, ds=0.00, dv=0.015),
        "bg_bottom": shift_color(CREAM, dh * 0.55, ds=0.07, dv=-0.045),
        "accent": shift_color(ORANGE, dh, ds=0.02, dv=0.0),
        "mustard": shift_color(MUSTARD, dh * 0.7, ds=0.0, dv=0.0),
    }


def gradient_image(width, height, top, bottom):
    img = Image.new("RGB", (width, height), top)
    draw = ImageDraw.Draw(img)
    for y in range(height):
        draw.line([(0, y), (width, y)],
                  fill=lerp_color(top, bottom, y / float(max(1, height - 1))))
    return img


# ------------------------------------------------------------- ornaments ----
def draw_filmstrip(draw, x, y, w, h, body, hole, holes=9):
    """A little film-strip band with two rows of perforations."""
    draw.rounded_rectangle([x, y, x + w, y + h], radius=max(3, int(h * 0.18)),
                           fill=body)
    pad = max(2, int(h * 0.16))
    hole_w = max(2, int(w / (holes * 2.4)))
    step = (w - 2 * pad) / float(holes)
    hole_h = max(2, int((h - 3 * pad) / 2))
    for i in range(holes):
        hx = x + pad + i * step
        draw.rounded_rectangle([hx, y + pad, hx + hole_w, y + pad + hole_h],
                               radius=max(1, hole_h // 3), fill=hole)
        draw.rounded_rectangle([hx, y + 2 * pad + hole_h, hx + hole_w,
                                y + 2 * pad + hole_h * 2],
                               radius=max(1, hole_h // 3), fill=hole)


def draw_sofa(draw, box, body, accent, outline):
    """Sofa silhouette: back, seat, arms, legs and two accent cushions."""
    x0, y0, x1, y1 = [float(v) for v in box]
    w = x1 - x0
    h = y1 - y0
    r = max(3, int(h * 0.10))

    # back rest
    draw.rounded_rectangle([x0 + w * 0.05, y0, x1 - w * 0.05, y0 + h * 0.45],
                           radius=r, fill=body)
    # seat
    draw.rounded_rectangle([x0 + w * 0.02, y0 + h * 0.40, x1 - w * 0.02,
                            y0 + h * 0.74], radius=max(2, int(h * 0.07)),
                           fill=body)
    # arms
    draw.rounded_rectangle([x0, y0 + h * 0.26, x0 + w * 0.14, y0 + h * 0.82],
                           radius=max(2, int(h * 0.06)), fill=body)
    draw.rounded_rectangle([x1 - w * 0.14, y0 + h * 0.26, x1, y0 + h * 0.82],
                           radius=max(2, int(h * 0.06)), fill=body)
    # accent cushions
    draw.rounded_rectangle([x0 + w * 0.17, y0 + h * 0.09, x0 + w * 0.47,
                            y0 + h * 0.36], radius=max(2, int(h * 0.06)),
                           fill=accent)
    draw.rounded_rectangle([x0 + w * 0.53, y0 + h * 0.09, x0 + w * 0.83,
                            y0 + h * 0.36], radius=max(2, int(h * 0.06)),
                           fill=accent)
    # legs
    leg_w = max(2.0, w * 0.055)
    draw.rectangle([x0 + w * 0.11, y0 + h * 0.74, x0 + w * 0.11 + leg_w,
                    y0 + h * 0.92], fill=outline)
    draw.rectangle([x1 - w * 0.11 - leg_w, y0 + h * 0.74, x1 - w * 0.11,
                    y0 + h * 0.92], fill=outline)


def draw_coffee_cup(draw, cx, base_y, size, fill, steam, saucer=None):
    """Coffee cup with a handle, a saucer and two wisps of steam."""
    s = float(size)
    cx = float(cx)
    base_y = float(base_y)
    body_left = cx - s * 0.42
    body_right = cx + s * 0.42
    body_top = base_y - s * 0.62
    draw.rounded_rectangle([body_left, body_top, body_right, base_y],
                           radius=max(2, int(s * 0.15)), fill=fill)
    # rim highlight
    draw.rounded_rectangle([body_left + s * 0.10, body_top + s * 0.08,
                            body_right - s * 0.10, body_top + s * 0.18],
                           radius=max(1, int(s * 0.05)), fill=steam)
    # handle
    try:
        draw.arc([cx + s * 0.28, base_y - s * 0.52, cx + s * 0.72,
                  base_y - s * 0.10], start=-90, end=90, fill=fill,
                 width=max(2, int(s * 0.11)))
    except Exception:
        pass
    # saucer
    if saucer is None:
        saucer = fill
    draw.ellipse([cx - s * 0.56, base_y - s * 0.03, cx + s * 0.56,
                  base_y + s * 0.11], fill=saucer)
    # steam
    for dx in (-s * 0.16, s * 0.11):
        try:
            draw.line([(cx + dx, base_y - s * 0.74),
                       (cx + dx + s * 0.07, base_y - s * 0.92),
                       (cx + dx - s * 0.05, base_y - s * 1.08),
                       (cx + dx + s * 0.03, base_y - s * 1.24)],
                      fill=steam, width=max(2, int(s * 0.055)), joint="curve")
        except Exception:
            pass


def draw_wordmark(draw, cx, cy, max_width, start_size, letter_fill, dot_fills):
    """F-R-I-E-N-D-S wordmark: seven letters spread across max_width with dots."""
    letters = "FRIENDS"
    size = int(start_size)
    spacing = 0.0
    letter_widths = []
    dot_width = 0
    font = load_font(LATIN_FONT_CANDIDATES, size)
    dot_font = load_font(LATIN_FONT_CANDIDATES, max(9, int(size * 0.5)))
    while size > 12:
        font = load_font(LATIN_FONT_CANDIDATES, size)
        dot_font = load_font(LATIN_FONT_CANDIDATES, max(9, int(size * 0.5)))
        letter_widths = [text_size(draw, ch, font)[0] for ch in letters]
        dot_width = text_size(draw, "\u00b7", dot_font)[0]
        total = sum(letter_widths) + 6 * dot_width
        spacing = (max_width - total) / 12.0
        if spacing >= max(1.5, size * 0.08):
            break
        size -= 2
    if not letter_widths:
        return
    baseline = cy + size * 0.36
    x = cx - max_width / 2.0
    dots = list(dot_fills) or [letter_fill]
    for i, ch in enumerate(letters):
        draw_text_baseline(draw, x, baseline, ch, font, letter_fill)
        x += letter_widths[i]
        x += spacing
        if i < len(letters) - 1:
            fill = dots[i % len(dots)]
            draw_text_baseline(draw, x, baseline - size * 0.05, "\u00b7",
                               dot_font, fill)
            x += dot_width + spacing


# ------------------------------------------------------------- posters ----
def series_poster(catalog, out_path):
    width, height = 600, 900
    title = str(catalog.get("title") or "老友记")
    cn_title = title.split()[0] if title.split() else "老友记"
    episodes = catalog.get("episodes") or []
    season = int((episodes[0] or {}).get("season") or 1) if episodes else 1
    year = catalog.get("year") or 1994
    count = len(episodes)

    top = shift_color(CREAM, dh=0.0, ds=0.0, dv=0.02)
    bottom = shift_color(CREAM, dh=0.0, ds=0.09, dv=-0.055)
    img = gradient_image(width, height, top, bottom)
    draw = ImageDraw.Draw(img)

    # faint coffee-ring texture
    ring = shift_color(CREAM, dh=0.0, ds=0.16, dv=-0.07)
    draw.ellipse([width - 180, height - 300, width + 70, height - 40],
                 outline=ring, width=3)
    draw.ellipse([width - 140, height - 260, width + 30, height - 80],
                 outline=ring, width=2)

    # top film strip
    draw_filmstrip(draw, 46, 44, 508, 58, ESPRESSO, top)
    # espresso band with the wordmark
    draw.rounded_rectangle([36, 136, 564, 262], radius=20, fill=ESPRESSO)
    draw_wordmark(draw, 300, 199, 468, 82, CREAM,
                  [ORANGE, MUSTARD, CREAM, ORANGE, MUSTARD, CREAM])

    # Chinese title
    cn_font = fit_font(draw, cn_title, CN_FONT_CANDIDATES, 66, 470)
    draw_text_center(draw, 300, 320, cn_title, cn_font, ESPRESSO)

    # season subtitle on a mustard pill
    cn_num = CN_DIGITS.get(season, str(season))
    subtitle = "第%s季 · SEASON %d" % (cn_num, season)
    sub_font = load_font(LATIN_FONT_CANDIDATES, 26)
    sub_font = fit_font(draw, subtitle, CN_FONT_CANDIDATES, 26, 420)
    sub_w = text_size(draw, subtitle, sub_font)[0]
    draw.rounded_rectangle([300 - (sub_w / 2.0 + 28), 366,
                            300 + (sub_w / 2.0 + 28), 410],
                           radius=22, fill=MUSTARD)
    draw_text_center(draw, 300, 388, subtitle, sub_font, ESPRESSO)

    # sofa + coffee table motif
    draw_sofa(draw, (74, 470, 452, 750), ESPRESSO, ORANGE, ESPRESSO)
    draw.rounded_rectangle([452, 716, 566, 732], radius=7, fill=ESPRESSO)
    draw_coffee_cup(draw, 509, 716, 74, ESPRESSO, MUSTARD)

    # bottom band
    draw.rounded_rectangle([46, 786, 554, 858], radius=16, fill=ESPRESSO)
    footer = "%s · %d EPISODES · 6 FRIENDS" % (year, count)
    foot_font = fit_font(draw, footer, LATIN_FONT_CANDIDATES, 19, 470)
    draw_text_center(draw, 300, 822, footer, foot_font, CREAM)

    save_jpeg(img, out_path)
    return width, height


def episode_poster(episode, out_path, catalog=None):
    width, height = 300, 450
    number = int(episode.get("number") or 1)
    season = int(episode.get("season") or 1)
    code = "S%02dE%02d" % (season, number)
    title_zh = str(episode.get("titleZh") or "").strip() or str(
        episode.get("titleEn") or code)
    title_en = str(episode.get("titleEn") or "").strip()

    pal = episode_palette(number)
    img = gradient_image(width, height, pal["bg_top"], pal["bg_bottom"])
    draw = ImageDraw.Draw(img)
    accent = pal["accent"]
    mustard = pal["mustard"]
    ring = shift_color(pal["bg_bottom"], dh=0.0, ds=0.10, dv=-0.05)
    draw.ellipse([width - 96, height - 132, width + 34, height - 2],
                 outline=ring, width=2)

    # top film strip + tiny wordmark
    draw_filmstrip(draw, 18, 15, 264, 22, ESPRESSO, pal["bg_top"], holes=11)
    draw_wordmark(draw, 150, 54, 206, 17, ESPRESSO,
                  [accent, mustard, ESPRESSO, accent, mustard, ESPRESSO])

    # big episode code, top-left corner
    code_font = fit_font(draw, code, LATIN_FONT_CANDIDATES, 56, 236)
    code_w, code_h, code_ox, code_oy = text_size(draw, code, code_font)
    draw.text((20 - code_ox, int(100 - code_h / 2.0 - code_oy)), code,
              font=code_font, fill=accent)
    draw.rounded_rectangle([20, 128, 20 + min(code_w, 226) + 4, 133],
                           radius=3, fill=mustard)

    # motif
    draw_sofa(draw, (40, 158, 236, 290), shift_color(ESPRESSO, 0.0, 0.0, 0.02),
              accent, ESPRESSO)
    draw.rounded_rectangle([232, 298, 284, 306], radius=4, fill=ESPRESSO)
    draw_coffee_cup(draw, 258, 298, 46, ESPRESSO, mustard)

    # Chinese title (<= 3 lines, fewer than 12 chars per line)
    lines = wrap_cjk(title_zh, max_chars=11, max_lines=3)
    title_font, line_h = fit_lines(draw, lines, CN_FONT_CANDIDATES, 34,
                                   max_width=258, max_height=78, min_size=12)
    total_h = line_h * len(lines)
    y = 312 + max(0, (78 - total_h) // 2)
    for line in lines:
        draw_text_center(draw, 150, y + line_h / 2.0, line, title_font, ESPRESSO)
        y += line_h

    # English title (small, bottom)
    en_lines = wrap_latin(draw, title_en,
                          load_font(LATIN_FONT_CANDIDATES, 13),
                          256, max_lines=2)
    if len(en_lines) > 2:
        en_lines = en_lines[:2]
    en_font = load_font(LATIN_FONT_CANDIDATES, 13)
    widest = max((text_size(draw, ln, en_font)[0] for ln in en_lines), default=0)
    if widest > 258 and en_lines:
        en_font = load_font(LATIN_FONT_CANDIDATES, 11)
        en_lines = wrap_latin(draw, title_en, en_font, 262, max_lines=2)
    en_y = 393
    for line in en_lines:
        draw_text_center(draw, 150, en_y, line, en_font, shift_color(ESPRESSO, 0, 0, 0.08))
        en_y += 14

    # season mark
    cn_num = CN_DIGITS.get(season, str(season))
    foot_font = fit_font(draw, "老友记 第%s季" % cn_num, CN_FONT_CANDIDATES, 13, 240)
    draw_text_center(draw, 150, 434, "老友记 第%s季" % cn_num, foot_font, accent)

    save_jpeg(img, out_path)
    return width, height


CN_DIGITS = {1: "一", 2: "二", 3: "三", 4: "四", 5: "五",
             6: "六", 7: "七", 8: "八", 9: "九", 10: "十"}


def save_jpeg(img, out_path):
    parent = os.path.dirname(os.path.abspath(out_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    img.convert("RGB").save(out_path, format="JPEG", quality=88, optimize=True)


# ---------------------------------------------------------------- main ----
def resolve_dir(catalog_path, poster_rel):
    """Resolve a catalog `poster` value ("posters/s01e01.jpg") -> file name part."""
    name = str(poster_rel or "").replace("\\", "/").rsplit("/", 1)[-1]
    return name


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    parser = argparse.ArgumentParser(
        description="Generate Friends-inspired series/episode posters with Pillow.")
    parser.add_argument("--catalog", default=os.path.join("data", "catalog.json"),
                        help="path to catalog.json")
    parser.add_argument("--out", default=os.path.join("data", "posters"),
                        help="output directory for the JPEG posters")
    args = parser.parse_args(argv)

    catalog_path = os.path.abspath(args.catalog)
    out_dir = os.path.abspath(args.out)

    if not os.path.isfile(catalog_path):
        sys.stderr.write("catalog not found: %s\n" % catalog_path)
        return 2
    try:
        with open(catalog_path, "r", encoding="utf-8") as fh:
            catalog = json.load(fh)
    except Exception as exc:
        sys.stderr.write("cannot read catalog %s: %s\n" % (catalog_path, exc))
        return 2

    os.makedirs(out_dir, exist_ok=True)
    ok = 0
    failed = 0

    # series poster
    show_name = resolve_dir(catalog_path, catalog.get("poster")) or "show.jpg"
    show_path = os.path.join(out_dir, show_name)
    try:
        width, height = series_poster(catalog, show_path)
        print("generated %s (%dx%d)" % (show_path, width, height))
        ok += 1
    except Exception as exc:
        sys.stderr.write("failed series poster: %s\n" % exc)
        failed += 1

    # episode posters
    for episode in catalog.get("episodes") or []:
        if not isinstance(episode, dict):
            continue
        episode_id = str(episode.get("episodeId") or
                         "s%02de%02d" % (int(episode.get("season") or 1),
                                         int(episode.get("number") or 1)))
        name = resolve_dir(catalog_path, episode.get("poster"))
        if not name:
            name = episode_id + ".jpg"
        path = os.path.join(out_dir, name)
        try:
            width, height = episode_poster(episode, path, catalog)
            print("generated %s (%dx%d)" % (path, width, height))
            ok += 1
        except Exception as exc:
            sys.stderr.write("failed %s: %s\n" % (path, exc))
            failed += 1

    print("done: %d posters written to %s%s" %
          (ok, out_dir, "" if not failed else " (%d failed)" % failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
