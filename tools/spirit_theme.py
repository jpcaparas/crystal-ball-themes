"""Render a talking spirit head floating inside the crystal ball.

The ball *is* a crystal ball, so this theme shows a fortune teller's spirit inside it, talking.
From one picture of the head (made by Gemini with Madame Zara's portrait as a reference) and three
edited copies (mouth half open, mouth open, eyes closed), this tool:

  - lines each copy up with the original (phase correlation), in case the edit nudged it;
  - finds the mouth and eyes by diffing the copies against the original, and feathers those regions;
  - swaps only those regions in time with the voice's loudness (lip-sync) and for random blinks;
  - "screen"-blends the head over swirling mist so it glows like a projection, floating gently.

Art and voices live in assets/sources/<id>/ (not in git) like the other voiced themes: missing ones
are made with Gemini, or by any other model or agent (see docs/media.md and `npm run media:plan`).

Usage:
  uv run --with-requirements tools/requirements.txt python tools/spirit_theme.py tools/scripts/spirit-in-the-ball.json
  ... --only awaken             just matching scenes
  ... --debug                   also write <out>/masks.png showing the found mouth/eye regions
  ... --draft --out /tmp/x      cartoon placeholder head + macOS voice, never calls the API
  ... --prepare                make missing art and voices only, then stop
  ... --jobs 4                  render four scenes at once
  ... --skip-missing            if media is missing and there's no API key, say so and exit 0
"""

import argparse
import json
import math
import os
import random
import shutil
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_halloween as mh  # noqa: E402
import voice_theme as vt  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, FPS, SR = mh.W, mh.FPS, mh.SR
ART = 1024  # working size of the head pictures
LEAD, TAIL = 1.4, 1.6
MOUTH_BOX = (0.30, 0.48, 0.70, 0.84)  # where to look for the mouth (fractions of the picture)
EYES_BOX = (0.18, 0.24, 0.82, 0.56)


def smoothstep(a, b, x):
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- art


def ensure_face_art(head_prompt, variants, refs, art_dir, draft, label="head"):
    """Head picture plus its edited variants (mouth-mid, mouth-open, blink); only missing files are made.
    Returns {name: path} with whichever picture format each was saved in."""
    paths = {}
    for key, prompt, inputs in [("head", head_prompt, refs)] + [(k, p, None) for k, p in variants.items()]:
        want = os.path.join(art_dir, f"{key}.jpg")
        paths[key] = vt.find_source(want)
        if paths[key]:
            continue
        if not draft:
            vt.require_generator(want)
        os.makedirs(art_dir, exist_ok=True)
        if draft:
            draft_face(want, key)
        else:
            inputs = [paths["head"]] if inputs is None else [vt.find_source(r) or r for r in inputs]
            for r in inputs:
                if not os.path.exists(r):
                    raise vt.MissingMedia(f"{os.path.relpath(r, REPO)}, the reference picture for {label}")
            from gemini_media import generate_image

            print(f"  art: {label}{'' if key == 'head' else ' ' + key}", flush=True)
            generate_image(prompt, want, refs=inputs)
        paths[key] = want
    return paths


def ensure_art(script, src, draft):
    ref = script.get("reference")  # optional: keeps a character consistent with an existing picture
    refs = [os.path.join(REPO, "assets", "sources", ref)] if ref else []
    return ensure_face_art(script["head"], script["variants"], refs, os.path.join(src, "art"), draft)


def draft_face(path, kind):
    """Cartoon stand-in for testing lip-sync without the API."""
    img = Image.new("RGB", (ART, ART), "black")
    d = ImageDraw.Draw(img)
    d.ellipse([312, 230, 712, 760], fill=(150, 120, 210))
    d.ellipse([300, 180, 724, 420], fill=(90, 40, 140))  # head wrap
    for ex in (420, 604):
        if kind == "blink":
            d.line([(ex - 40, 470), (ex + 40, 470)], fill=(30, 20, 40), width=10)
        else:
            d.ellipse([ex - 34, 440, ex + 34, 500], fill=(240, 240, 255))
            d.ellipse([ex - 14, 456, ex + 14, 484], fill=(30, 20, 40))
    mouth = {"mouth-mid": (470, 615, 554, 650), "mouth-open": (460, 600, 564, 690)}.get(kind)
    if mouth:
        d.ellipse(mouth, fill=(40, 10, 30))
    else:
        d.line([(470, 630), (554, 630)], fill=(40, 10, 30), width=10)
    img.save(path, quality=92)


def load(path):
    img = Image.open(path).convert("RGB")
    side = min(img.size)
    img = img.crop(((img.width - side) // 2, (img.height - side) // 2, (img.width + side) // 2, (img.height + side) // 2))
    return np.asarray(img.resize((ART, ART), Image.LANCZOS), np.float32) / 255.0


def align(ref, img):
    """Shift img so it lines up with ref (phase correlation on a small greyscale copy)."""
    small = 256
    k = ART // small

    def g(a):
        return np.asarray(Image.fromarray((a * 255).astype(np.uint8)).convert("L").resize((small, small)), np.float32)

    fa, fb = np.fft.fft2(g(ref)), np.fft.fft2(g(img))
    r = np.real(np.fft.ifft2(fa * np.conj(fb) / (np.abs(fa * np.conj(fb)) + 1e-9)))
    dy, dx = np.unravel_index(np.argmax(r), r.shape)
    dy = dy - small if dy > small // 2 else dy
    dx = dx - small if dx > small // 2 else dx
    return np.roll(img, (int(dy) * k, int(dx) * k), axis=(0, 1)), (int(dy) * k, int(dx) * k)


def region_mask(base, var, box):
    """Feathered elliptical mask around where `var` differs from `base` inside `box`."""
    d = np.abs(var - base).mean(axis=2)
    d = np.asarray(Image.fromarray((d * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6)), np.float32) / 255
    x0, y0, x1, y1 = (int(v * ART) for v in box)
    roi = d[y0:y1, x0:x1]
    t = max(0.05, float(np.percentile(roi, 97)) * 0.5)
    ys, xs = np.nonzero(roi > t)
    if len(xs) < 40:
        return None, None
    bx0, bx1, by0, by1 = xs.min() + x0, xs.max() + x0, ys.min() + y0, ys.max() + y0
    px, py = (bx1 - bx0) * 0.22 + 12, (by1 - by0) * 0.3 + 12
    bbox = (int(bx0 - px), int(by0 - py), int(bx1 + px), int(by1 + py))
    m = Image.new("L", (ART, ART), 0)
    ImageDraw.Draw(m).ellipse(bbox, fill=255)
    m = m.filter(ImageFilter.GaussianBlur(max(8, (bbox[2] - bbox[0]) * 0.12)))
    return np.asarray(m, np.float32) / 255, bbox


class Face:
    def __init__(self, paths, debug_path=None, boxes=None, quiet=False):
        boxes = boxes or {}
        self.base = load(paths["head"])
        self.v = {}
        self.masks = {}
        report = []
        for key in ("mouth-mid", "mouth-open", "blink"):
            img, shift = align(self.base, load(paths[key]))
            self.v[key] = img
            box = boxes.get("eyes", EYES_BOX) if key == "blink" else boxes.get("mouth", MOUTH_BOX)
            m, bbox = region_mask(self.base, img, tuple(box))
            self.masks[key] = m
            report.append(f"{key}: shift {shift}, region {bbox}")
        # one mouth mask covering both mouth shapes, so switching between them never shows a seam
        mm = [m for k, m in self.masks.items() if k != "blink" and m is not None]
        self.mouth = np.maximum.reduce(mm) if mm else None
        self.eyes = self.masks["blink"]
        if not quiet:
            print("  face: " + "; ".join(report), flush=True)
        if self.mouth is None and not quiet:
            print("  warning: no mouth movement found between the pictures; regenerate the variants", flush=True)
        if debug_path:
            vis = (self.base * 255).astype(np.uint8).copy()
            for m, col in ((self.mouth, (255, 60, 60)), (self.eyes, (60, 200, 255))):
                if m is not None:
                    a = (m[..., None] * 0.55)
                    vis = (vis * (1 - a) + np.array(col) * a).astype(np.uint8)
            Image.fromarray(vis).save(debug_path)

    def frame(self, loud, blink):
        f = self.base
        if self.mouth is not None:
            mid_w = smoothstep(0.10, 0.30, loud) * (1 - smoothstep(0.42, 0.62, loud))
            open_w = smoothstep(0.42, 0.62, loud)
            if mid_w or open_w:
                f = f + self.mouth[..., None] * (mid_w * (self.v["mouth-mid"] - self.base) + open_w * (self.v["mouth-open"] - self.base))
        if self.eyes is not None and blink > 0:
            f = f + self.eyes[..., None] * blink * (self.v["blink"] - f)
        return np.clip(f, 0, 1)


# ---------------------------------------------------------------- scene


def noise_layer(seed, size, blur):
    rng = np.random.default_rng(seed)
    n = rng.uniform(0, 255, (size // 48, size // 48)).astype(np.uint8)
    return Image.fromarray(n, "L").resize((size, size), Image.BICUBIC).filter(ImageFilter.GaussianBlur(blur))


def screen(a, b):
    return 1 - (1 - a) * (1 - b)


def smoothstep_arr(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def make_warp(sway_amp=0.0, bulge=0.0):
    """Remap for each frame: slow underwater drift for hair and mist (never the face, so lip-sync stays
    still) and an optional crystal-ball bulge (the middle is magnified, like looking into a glass ball)."""
    yy, xx = np.mgrid[0:W, 0:W].astype(np.float32)
    cx, cy = W * 0.5, W * 0.47
    dist = np.hypot(xx - cx, yy - cy)
    wgt = smoothstep_arr(0.17, 0.42, dist / W)
    ux, uy = (xx - cx) / (dist + 1e-3), (yy - cy) / (dist + 1e-3)
    k = 2 * np.pi / (W * 0.24)
    if bulge:
        r = np.hypot(xx - W / 2, yy - W / 2) / (W / 2)
        scale = 1 - bulge + bulge * np.minimum(r, 1.0) ** 2
        bx, by = W / 2 + (xx - W / 2) * scale, W / 2 + (yy - W / 2) * scale
    else:
        bx, by = xx, yy

    def warp(img, t):
        sx, sy = bx, by
        if sway_amp:
            dx = sway_amp * wgt * (np.sin(yy * k + t * 0.9) + 0.5 * np.sin(yy * k * 0.5 - t * 0.6 + 1.3))
            dy = sway_amp * wgt * np.sin(xx * k * 0.8 + t * 0.7 + 2.1)
            breathe = sway_amp * 0.7 * wgt * math.sin(t * 0.8)  # hair gently billows in and out
            sx, sy = sx - dx - ux * breathe, sy - dy - uy * breathe
        sx = np.clip(sx, 0, W - 1.001)
        sy = np.clip(sy, 0, W - 1.001)
        x0, y0 = sx.astype(np.int32), sy.astype(np.int32)
        fx, fy = (sx - x0)[..., None], (sy - y0)[..., None]
        return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy)
                + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)

    return warp


def grade_moody(img):
    """Low-key and mysterious: a little less colour, midnight-blue shadows, a touch of amber in the light."""
    lum = (img @ np.array([0.299, 0.587, 0.114], np.float32))[..., None]
    img = lum + (img - lum) * 0.8
    shade = (1 - lum) ** 2 * 0.4
    img = img * (1 - shade) + np.array([0.04, 0.06, 0.16], np.float32) * shade
    img = img + (np.array([1.0, 0.8, 0.58], np.float32) - img) * (lum ** 3) * 0.12
    return np.clip(img, 0, 1) ** 1.1


def grade_spectral_green(img):
    """A ghostly green wash over the finished picture (the art itself keeps its natural colours):
    luminance mapped through a deep-green to pale-mint ramp, blended over the original."""
    lum = (img @ np.array([0.299, 0.587, 0.114], np.float32))[..., None]
    dark = np.array([0.0, 0.05, 0.035], np.float32)
    mid = np.array([0.2, 0.66, 0.46], np.float32)
    light = np.array([0.86, 1.0, 0.86], np.float32)
    toned = np.where(lum < 0.5, dark + (mid - dark) * (lum / 0.5), mid + (light - mid) * ((lum - 0.5) / 0.5))
    return np.clip(img * 0.3 + toned * 0.7, 0, 1) ** 1.05


GRADES = {"moody": grade_moody, "spectral-green": grade_spectral_green}


def render_scene(script, scene, face, voice_path, out_path):
    voice = vt.read_voice(voice_path)
    vsecs = len(voice) / SR
    secs = LEAD + vsecs + TAIL
    n = int(round(secs * FPS))
    env = vt.envelope(voice, n, LEAD)
    rnd = random.Random(vt.seed_of(scene["file"]))
    blinks, t = [], 1.6
    while t < secs - 0.5:
        blinks.append(t)
        t += rnd.uniform(2.4, 4.8)

    bg = np.asarray(mh.radial_bg((40, 18, 70), (3, 2, 8), center=(0.5, 0.55), radius=0.62).convert("RGB"), np.float32) / 255
    big = int(W * 1.5)
    mist_a = noise_layer(vt.seed_of(scene["file"] + "a"), big, 50)
    mist_b = noise_layer(vt.seed_of(scene["file"] + "b"), big, 70)
    front = noise_layer(vt.seed_of(scene["file"] + "c"), W * 2, 40)
    sparkles = [(rnd.uniform(0.15, 0.85) * W, rnd.uniform(0.12, 0.88) * W, rnd.uniform(0, 6), rnd.uniform(0.6, 1.6)) for _ in range(30)]
    glass = Image.new("L", (W, W), 0)
    ImageDraw.Draw(glass).arc([W * 0.12, W * 0.12, W * 0.88, W * 0.88], 200, 250, fill=255, width=int(W * 0.03))
    glass = np.asarray(glass.filter(ImageFilter.GaussianBlur(14)), np.float32)[..., None] / 255 * 0.18
    head_size = int(W * 1.14)  # big enough to read on a 7 cm ball
    face_y = 0.42  # where her face centre sits in the head picture

    def spun(layer, angle):
        r = layer.rotate(angle, resample=Image.BILINEAR)
        o = (big - W) // 2
        return np.asarray(r.crop((o, o, o + W, o + W)), np.float32)[..., None] / 255

    look = script.get("look", {})
    warp = (make_warp(look.get("sway", 0) * mh.S, look.get("glass", 0))
            if look.get("sway") or look.get("glass") else None)
    grade = GRADES.get(look.get("grade"))
    light = np.array(look.get("light", [1.0, 0.62, 0.3]), np.float32)  # under-light colour
    bloom = np.array(look["bloom"], np.float32) if look.get("bloom") else None
    under = Image.new("L", (W, W), 0)
    ImageDraw.Draw(under).ellipse([W * 0.3, W * 0.55, W * 0.7, W * 0.95], fill=255)
    under = np.asarray(under.filter(ImageFilter.GaussianBlur(70)), np.float32)[..., None] / 255

    cap_font = mh.fit_font(scene["title"], W * 0.7, 60 * mh.S, stroke=10) if look.get("caption") else None

    def render_baked(t):
        """The picture brings its own misty background; it fills the ball, and its hair and mist drift."""
        i = min(n - 1, int(t * FPS))
        e = float(env[i])
        appear = smoothstep(0.2, 1.6, t) * (1 - smoothstep(secs - 1.3, secs - 0.1, t))
        blink = max((max(0.0, 1 - abs((t - b) / 0.09 - 1)) for b in blinks), default=0.0)
        f = face.frame(e, blink)
        size = int(W * look.get("scale", 1.06))
        head = Image.fromarray((f * 255).astype(np.uint8)).rotate(0.8 * math.sin(t * 0.5), resample=Image.BICUBIC)
        head = head.resize((size, size), Image.BILINEAR)
        o = (size - W) // 2
        bob = int(round(4 * math.sin(t * 1.1)))
        img = np.asarray(head.crop((o, o - bob, o + W, o + W - bob)), np.float32) / 255
        if warp:
            img = warp(img, t)
        m = look.get("mist", 0.3)
        img = screen(img, spun(mist_a, t * 5) * np.array([0.30, 0.25, 0.60]) * m)
        img = screen(img, spun(mist_b, -t * 4) * np.array([0.10, 0.40, 0.50]) * m * 0.7)
        img = screen(img, under * light * (0.12 + 0.3 * e))  # under-light breathes with her voice
        if grade:
            img = grade(img)
        if bloom is not None:  # soft glow around the brightest parts, stronger as she speaks
            q = Image.fromarray((img * 255).astype(np.uint8)).convert("L").resize((W // 4, W // 4))
            q = q.point(lambda v: max(0, v - 70) * 2).filter(ImageFilter.GaussianBlur(9)).resize((W, W), Image.BILINEAR)
            img = screen(img, np.asarray(q, np.float32)[..., None] / 255 * bloom * (0.45 + 0.35 * e + 0.05 * math.sin(t * 9)))
        off = int((t / secs) * W)
        fm = np.asarray(front.crop((off, 0, off + W, W)), np.float32)[..., None] / 255
        low = np.linspace(0, 1, W, dtype=np.float32)[:, None, None] ** 2
        img = screen(img, fm * low * np.array([0.35, 0.4, 0.6]) * 0.35)
        img = np.clip(img * (0.15 + 0.85 * appear) + glass * 0.6, 0, 1)
        out = Image.fromarray((img * 255).astype(np.uint8))
        if appear < 1:
            out = out.filter(ImageFilter.GaussianBlur(10 * (1 - appear)))
        out = out.convert("RGBA")
        if cap_font:  # who's talking, for little viewers
            k = smoothstep(0.5, 1.2, t) * (1 - smoothstep(secs - 1.2, secs - 0.5, t))
            if k > 0:
                tl = mh.text_layer(scene["title"], cap_font, (255, 236, 200, 255), 10, (25, 10, 35, 255), center=(W / 2, W * 0.84))
                tl.putalpha(tl.getchannel("A").point(lambda v: int(v * k)))
                out.alpha_composite(tl)
        d = ImageDraw.Draw(out)
        for x, y, ph, sp in sparkles[:14]:
            a = max(0.0, math.sin(t * sp * 1.5 + ph)) * 0.6 * appear
            if a > 0.1:
                r = 6 * a
                c = (220, 230, 255, int(200 * a))
                d.line([(x - r, y), (x + r, y)], fill=c, width=2)
                d.line([(x, y - r), (x, y + r)], fill=c, width=2)
        return mh.finish(out)

    def render(t):
        i = min(n - 1, int(t * FPS))
        e = float(env[i])
        appear = smoothstep(0.2, 1.3, t) * (1 - smoothstep(secs - 1.1, secs - 0.1, t))

        img = bg.copy()
        img = screen(img, spun(mist_a, t * 7) * np.array([0.45, 0.25, 0.75]) * 0.55)
        img = screen(img, spun(mist_b, -t * 5) * np.array([0.15, 0.55, 0.6]) * 0.35)
        glow = Image.new("L", (W, W), 0)
        ImageDraw.Draw(glow).ellipse([W * 0.25, W * 0.6, W * 0.75, W * 1.05], fill=int(90 + 90 * e))
        g = np.asarray(glow.filter(ImageFilter.GaussianBlur(60)), np.float32)[..., None] / 255
        img = screen(img, g * np.array([0.7, 0.45, 1.0]) * 0.6)

        # the head: lip-synced, blinking, floating, glowing
        blink = max((max(0.0, 1 - abs((t - b) / 0.09 - 1)) for b in blinks), default=0.0)
        f = face.frame(e, blink)
        head = Image.fromarray((f * 255).astype(np.uint8)).rotate(2.2 * math.sin(t * 0.7), resample=Image.BICUBIC)
        head = head.resize((head_size, head_size), Image.BILINEAR)
        if appear < 1:
            head = head.filter(ImageFilter.GaussianBlur(14 * (1 - appear)))
        layer = Image.new("RGB", (W, W), "black")
        bob = 10 * math.sin(t * 1.3)
        layer.paste(head, ((W - head_size) // 2, int(W * 0.47 - face_y * head_size + bob)))
        h = np.asarray(layer, np.float32) / 255
        aura = np.asarray(layer.convert("L").filter(ImageFilter.GaussianBlur(28)), np.float32)[..., None] / 255
        flicker = 0.92 + 0.05 * math.sin(t * 13) + 0.08 * e
        img = screen(img, aura * np.array([0.35, 0.8, 0.85]) * 0.5 * appear)
        img = screen(img, h * flicker * appear)

        # mist drifting in front of her neck, sparkles, a glint of glass
        off = int((t / secs) * W)
        fm = np.asarray(front.crop((off, 0, off + W, W)), np.float32)[..., None] / 255
        low = np.linspace(0, 1, W, dtype=np.float32)[:, None, None] ** 1.5
        img = screen(img, fm * low * np.array([0.6, 0.55, 0.85]) * 0.5)
        out = Image.fromarray((np.clip(img + glass, 0, 1) * 255).astype(np.uint8)).convert("RGBA")
        d = ImageDraw.Draw(out)
        for x, y, ph, sp in sparkles:
            a = max(0.0, math.sin(t * sp * 2 + ph))
            if a > 0.1:
                r = 7 * a
                c = (255, 235, 255, int(220 * a))
                d.line([(x - r, y), (x + r, y)], fill=c, width=3)
                d.line([(x, y - r), (x, y + r)], fill=c, width=3)
        return mh.finish(out)

    # sound: the voice with a ghostly echo, over a soft pad, wind and a chime as she appears
    audio = np.zeros((int(secs * SR), 2), np.float32)
    for f0 in (220.0, 261.63, 329.63):
        audio += mh.to_stereo(mh.tone(f0, secs, (0.6, 0.2), 1.5, 1.5, vibrato=0.004, vib_rate=0.2) * 0.045)
    audio += mh.to_stereo(mh.wind(secs, vt.seed_of(scene["file"]) & 0xFF, 0.05))
    for k, f0 in enumerate((987.77, 1318.5, 1567.98, 1975.53)):
        mh.place(audio[:, k % 2], mh.tone(f0, 1.6, (1, 0.3), 0.004, 1.4), 0.25 + k * 0.14, 0.07)
    dry = voice / (np.abs(voice).max() or 1.0) * 0.85
    wet = dry.copy()
    for delay, gain, ch in ((0.13, 0.30, 1), (0.26, 0.20, 0), (0.41, 0.13, 1), (0.6, 0.08, 0)):
        s = int(delay * SR)
        wet[s:, ch] += dry[: len(dry) - s, ch] * gain
    if look.get("grade") in GRADES:  # a low drone under everything for the darker mood
        audio += mh.to_stereo(mh.tone(55.0, secs, (0.6, 0.3, 0.1), 2.0, 2.0, vibrato=0.003, vib_rate=0.15) * 0.08)
    i = int(LEAD * SR)
    j = min(len(audio), i + len(wet))
    audio[i:j] += wet[: j - i]
    frame = render_baked if look.get("background") == "baked" else render
    mh.encode(out_path, secs, frame, mh.master(audio, secs, peak=0.8, fade=0.3))


# ---------------------------------------------------------------- main


_FACES = {}


def render_job(script, scene, face, voice_path, out_path):
    """Render one scene. `face` is a Face, or (paths, debug_path, boxes) to build one in this process."""
    if not isinstance(face, Face):
        cache_key = json.dumps(face, sort_keys=True)
        if cache_key not in _FACES:
            _FACES[cache_key] = Face(*face, quiet=True)
        face = _FACES[cache_key]
    print(f"rendering {scene['file']}.mp4", flush=True)
    render_scene(script, scene, face, voice_path, out_path)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("script")
    ap.add_argument("--out")
    ap.add_argument("--only")
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--draft", action="store_true")
    ap.add_argument("--prepare", action="store_true", help="make missing art and voices (and masks with --debug), then stop")
    ap.add_argument("--jobs", type=int, default=1, help="render this many scenes at once")
    ap.add_argument("--skip-missing", action="store_true", help="exit 0 (with a note) if media is missing and there's no key")
    args = ap.parse_args()

    with open(args.script, encoding="utf-8") as fh:
        script = json.load(fh)
    if args.draft and not args.out:
        sys.exit("--draft needs --out, so drafts never land in the real theme folders")
    sid = script["id"]
    out_dir = args.out or os.path.join(REPO, "assets", "themes", sid)
    src = os.path.join(args.out, "_draft-sources") if args.draft else os.path.join(REPO, "assets", "sources", sid)
    os.makedirs(out_dir, exist_ok=True)

    scenes = [s for s in script["scenes"] if not args.only or args.only in s["file"]]
    cast = script.get("characters")
    faces, specs, looks, voices = {}, {}, {}, {}
    try:
        if cast:
            # A cast: each scene names a character, which brings its own picture, voice and acting.
            needed = sorted({sc["character"] for sc in scenes}) if args.only else sorted(cast)
            for key in needed:
                ch = cast[key]
                refs = [os.path.join(REPO, "assets", "sources", ch["reference"])] if ch.get("reference") else []
                paths = ensure_face_art(f"{script.get('art_style', '')} {ch['head']}".strip(), ch.get("variants", script["variants"]),
                                        refs, os.path.join(src, "art", key), args.draft, label=key)
                specs[key] = (paths, None, ch.get("boxes"))
                faces[key] = Face(paths, os.path.join(out_dir, f"masks-{key}.png") if args.debug else None, ch.get("boxes"))
                looks[key] = {**script.get("look", {}), **ch.get("look", {})}
            for sc in scenes:
                ch = cast[sc["character"]]
                sc.setdefault("voice", ch.get("voice", script.get("voice")))
                sc.setdefault("style", ch.get("style", script.get("style")))
        else:
            paths = ensure_art(script, src, args.draft)
            specs[None] = (paths, None, None)
            faces[None] = Face(paths, os.path.join(out_dir, "masks.png") if args.debug else None)
            for sc in scenes:
                sc.setdefault("voice", script["voice"])
                sc.setdefault("style", script["style"])
        for sc in scenes:
            voices[sc["file"]] = vt.ensure_voice(sc, os.path.join(src, "voice", f"{sc['file']}.flac"), args.draft)
    except vt.MissingMedia as err:
        vt.missing_media_exit(script, err, args.skip_missing)
    if args.prepare:
        print("art and voices ready", flush=True)
        return
    jobs = []
    for sc in scenes:
        key = sc.get("character") if cast else None
        scene_script = {**script, "look": looks[key]} if cast else script
        # worker processes get the picture paths and rebuild the face, which is cheaper than sending it
        face = faces[key] if args.jobs <= 1 else specs[key]
        jobs.append((scene_script, sc, face, voices[sc["file"]], os.path.join(out_dir, f"{sc['file']}.mp4")))
    vt.run_jobs(render_job, jobs, args.jobs)

    meta = {"name": script["name"], "emoji": script["emoji"], "note": script["note"],
            "titles": {f"{s['file']}.mp4": s["title"] for s in script["scenes"]},
            "credits": "Art: Gemini Nano Banana 2.1. Voice: Gemini 3.8 Flash TTS."}
    with open(os.path.join(out_dir, "theme.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    if args.draft:
        shutil.rmtree(src, ignore_errors=True)


if __name__ == "__main__":
    main()
