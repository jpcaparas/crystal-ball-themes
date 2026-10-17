"""Render the built-in Halloween theme for the crystal ball.

Every clip is original artwork drawn here with Pillow, plus synthesized sound,
encoded in the format the ball's stock player uses:
480x480 H.264 Constrained Baseline (level 3.0), 30 fps, MP3 128 kbps 44.1 kHz stereo.

The screen is round, so everything important stays inside the centre circle.

Usage: uv run --with-requirements tools/requirements.txt python tools/make_halloween.py OUT_DIR [clip ...]
"""

import json
import math
import os
import random
import subprocess
import sys
import tempfile
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = 480  # ball resolution
S = 2  # supersampling factor for smooth edges
W = OUT * S
FPS = 30
SR = 44100
FONT_DIR = "/System/Library/Fonts/Supplemental"


# ---------------------------------------------------------------- helpers


def font(name, size, index=0):
    return ImageFont.truetype(os.path.join(FONT_DIR, name), size, index=index)


def chalkboard_bold(size):
    # Chalkboard SE: index 0 Regular, 1 Light, 2 Bold
    for idx in (2, 0):
        f = font("ChalkboardSE.ttc", size, idx)
        if "Bold" in " ".join(f.getname()):
            return f
    return font("ChalkboardSE.ttc", size, 0)


def fit_font(text, max_width, start, stroke=0):
    """Largest Chalkboard Bold size (<= start) whose rendering of text fits max_width."""
    size = start
    probe = ImageDraw.Draw(Image.new("L", (1, 1)))
    while size > 10:
        f = chalkboard_bold(size)
        if probe.textlength(text, font=f) + 2 * stroke <= max_width:
            return f
        size -= 4
    return chalkboard_bold(size)


def ease_out_back(t):
    c1, c3 = 1.70158, 2.70158
    t = min(max(t, 0.0), 1.0)
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2


def smooth(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)


def radial_bg(inner, outer, center=(0.5, 0.5), radius=0.75):
    y, x = np.mgrid[0:W, 0:W].astype(np.float32) / W
    d = np.sqrt((x - center[0]) ** 2 + (y - center[1]) ** 2) / radius
    d = np.clip(d, 0, 1)[..., None]
    c = np.array(inner, np.float32) * (1 - d) + np.array(outer, np.float32) * d
    return Image.fromarray(c.astype(np.uint8), "RGB").convert("RGBA")


def vertical_bg(top, bottom):
    t = np.linspace(0, 1, W, dtype=np.float32)[:, None, None]
    c = np.array(top, np.float32) * (1 - t) + np.array(bottom, np.float32) * t
    c = np.broadcast_to(c, (W, W, 3))
    return Image.fromarray(c.astype(np.uint8), "RGB").convert("RGBA")


def glow_layer(mask, color, radius, strength=1.0):
    """Soft coloured halo from an L-mode mask (blurred at quarter size for speed)."""
    q = 4
    small = mask.resize((W // q, W // q), Image.BILINEAR)
    small = small.filter(ImageFilter.GaussianBlur(max(1, radius / q)))
    big = small.resize((W, W), Image.BILINEAR)
    if strength != 1.0:
        big = big.point(lambda v: min(255, int(v * strength)))
    layer = Image.new("RGBA", (W, W), tuple(color) + (0,))
    layer.putalpha(big)
    return layer


def make_stars(n, seed, area=None):
    rnd = random.Random(seed)
    stars = []
    while len(stars) < n:
        x, y = rnd.uniform(0, W), rnd.uniform(0, W)
        if area and not area(x, y):
            continue
        stars.append((x, y, rnd.uniform(0, math.tau), rnd.uniform(1.2, 3.2) * S, rnd.uniform(0.6, 1.6)))
    return stars


def draw_stars(img, stars, t):
    d = ImageDraw.Draw(img)
    for x, y, ph, r, sp in stars:
        a = 0.45 + 0.55 * (0.5 + 0.5 * math.sin(t * sp * 2 + ph))
        c = int(255 * a)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(c, c, min(255, c + 20), 255))


def text_center(draw, xy, text, fnt, fill, stroke=0, stroke_fill=None):
    draw.text(xy, text, font=fnt, fill=fill, anchor="mm", stroke_width=stroke, stroke_fill=stroke_fill)


def text_layer(text, fnt, fill, stroke, stroke_fill, scale=1.0, center=(W / 2, W / 2), angle=0.0):
    """Render text on its own layer so it can be scaled/rotated around its centre."""
    layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    text_center(d, (W / 2, W / 2), text, fnt, fill, stroke, stroke_fill)
    if scale != 1.0 or angle:
        layer = layer.rotate(angle, resample=Image.BICUBIC, center=(W / 2, W / 2))
        if scale != 1.0:
            s = max(1, int(W * scale))
            layer = layer.resize((s, s), Image.BICUBIC)
    out = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    out.alpha_composite(layer, (int(center[0] - layer.width / 2), int(center[1] - layer.height / 2)))
    return out


def vignette():
    """Darken toward the circle edge so the round screen looks finished."""
    y, x = np.mgrid[0:W, 0:W].astype(np.float32) / W
    d = np.sqrt((x - 0.5) ** 2 + (y - 0.5) ** 2)
    a = np.clip((d - 0.36) / 0.16, 0, 1) * 200
    v = np.zeros((W, W, 4), np.uint8)
    v[..., 3] = a.astype(np.uint8)
    return Image.fromarray(v, "RGBA")


VIGNETTE = None


def finish(img):
    global VIGNETTE
    if VIGNETTE is None:
        VIGNETTE = vignette()
    img.alpha_composite(VIGNETTE)
    return img.convert("RGB").resize((OUT, OUT), Image.LANCZOS)


# ---------------------------------------------------------------- audio


def t_axis(seconds):
    return np.arange(int(seconds * SR), dtype=np.float32) / SR


def wind(seconds, seed=1, level=0.25):
    rng = np.random.default_rng(seed)
    n = rng.standard_normal(int(seconds * SR)).astype(np.float32)
    # cheap lowpass by cumulative moving averages
    k = 220
    n = np.convolve(n, np.ones(k, np.float32) / k, mode="same")
    tt = t_axis(seconds)
    swell = 0.55 + 0.45 * np.sin(2 * np.pi * tt / 5.0) * np.sin(2 * np.pi * tt / 3.1 + 1)
    n = n / (np.abs(n).max() + 1e-9)
    return n * swell * level


def tone(freq, seconds, harmonics=(1.0,), attack=0.01, release=0.2, vibrato=0.0, vib_rate=5.0):
    tt = t_axis(seconds)
    f = freq if np.isscalar(freq) else freq
    phase_f = f * (1 + vibrato * np.sin(2 * np.pi * vib_rate * tt))
    phase = 2 * np.pi * np.cumsum(phase_f if not np.isscalar(phase_f) else np.full_like(tt, phase_f)) / SR
    sig = sum(a * np.sin((i + 1) * phase) for i, a in enumerate(harmonics))
    env = np.ones_like(tt)
    na, nr = int(attack * SR), int(release * SR)
    if na:
        env[:na] = np.linspace(0, 1, na)
    if nr:
        env[-nr:] *= np.linspace(1, 0, nr)
    return (sig * env).astype(np.float32)


def place(buf, sig, at, gain=1.0):
    i = int(at * SR)
    j = min(len(buf), i + len(sig))
    if i < len(buf):
        buf[i:j] += sig[: j - i] * gain


def to_stereo(mono, pan=0.0):
    left = mono * (1 - max(0, pan))
    right = mono * (1 + min(0, pan))
    return np.stack([left, right], axis=1)


def master(stereo, seconds, peak=0.6, fade=0.4):
    n = int(seconds * SR)
    stereo = stereo[:n]
    if len(stereo) < n:
        stereo = np.vstack([stereo, np.zeros((n - len(stereo), 2), np.float32)])
    m = np.abs(stereo).max()
    if m > 0:
        stereo = stereo / m * peak
    nf = int(fade * SR)
    ramp = np.linspace(0, 1, nf, dtype=np.float32)[:, None]
    stereo[:nf] *= ramp
    stereo[-nf:] *= ramp[::-1]
    return stereo


def write_wav(path, stereo):
    data = (np.clip(stereo, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


# ---------------------------------------------------------------- encoder


def encode(path, seconds, render_frame, audio):
    n = int(round(seconds * FPS))
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "a.wav")
        write_wav(wav, audio)
        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{OUT}x{OUT}", "-r", str(FPS), "-i", "-",
            "-i", wav,
            "-map", "0:v", "-map", "1:a",
            "-c:v", "libx264", "-profile:v", "baseline", "-level", "3.0", "-pix_fmt", "yuv420p",
            "-preset", "slow", "-b:v", "1800k", "-maxrate", "2500k", "-bufsize", "4000k", "-g", "60",
            "-c:a", "libmp3lame", "-b:a", "128k", "-ar", str(SR), "-ac", "2",
            "-shortest", path,
        ]
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        for i in range(n):
            frame = render_frame(i / FPS)
            p.stdin.write(frame.tobytes())
            if i % 90 == 0:
                print(f"  {os.path.basename(path)}: {i}/{n}", flush=True)
        p.stdin.close()
        if p.wait() != 0:
            raise SystemExit(f"ffmpeg failed for {path}")


# ---------------------------------------------------------------- clip 1: jack-o'-lantern


def clip_pumpkin(path):
    secs = 15.0
    bg = radial_bg((70, 25, 90), (8, 4, 16), center=(0.5, 0.55), radius=0.7)
    stars = make_stars(40, 11, area=lambda x, y: y < W * 0.45)
    cx, cy = W / 2, W * 0.56

    body = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(body)
    ribs = [(-190, 300, (196, 84, 8)), (190, 300, (196, 84, 8)), (-100, 330, (226, 108, 18)),
            (100, 330, (226, 108, 18)), (0, 340, (246, 132, 28))]
    for dx, w, col in ribs:
        d.ellipse([cx + dx - w / 2, cy - 230, cx + dx + w / 2, cy + 230], fill=col + (255,),
                  outline=(150, 60, 5, 255), width=6)
    # top highlight
    hl = Image.new("L", (W, W), 0)
    ImageDraw.Draw(hl).ellipse([cx - 150, cy - 210, cx + 60, cy - 120], fill=70)
    hl = hl.filter(ImageFilter.GaussianBlur(30))
    shine = Image.new("RGBA", (W, W), (255, 220, 150, 0))
    shine.putalpha(hl)
    body.alpha_composite(shine)
    # stem
    d = ImageDraw.Draw(body)
    d.polygon([(cx - 28, cy - 215), (cx + 26, cy - 215), (cx + 40, cy - 300), (cx + 70, cy - 330),
               (cx + 52, cy - 340), (cx + 14, cy - 300)], fill=(84, 110, 40, 255), outline=(50, 70, 20, 255))
    leaf = [(cx - 30, cy - 225), (cx - 110, cy - 280), (cx - 60, cy - 300), (cx - 15, cy - 250)]
    d.polygon(leaf, fill=(60, 140, 50, 255), outline=(30, 90, 30, 255))

    def eye(side, blink):
        ex = cx + side * 115
        base, top = cy - 40, cy - 140
        h = (base - top) * blink
        return [(ex - 60, base), (ex + 60, base), (ex + side * 10, base - h)]

    def mouth():
        pts_top, pts_bot = [], []
        for i in range(21):
            x = -220 + i * 22
            u = x / 220
            pts_top.append((cx + x, cy + 45 + 55 * (1 - u * u)))
            pts_bot.append((cx + x, cy + 60 + 150 * (1 - u * u) ** 0.8))
        return pts_top + pts_bot[::-1]

    def teeth():
        return [
            [(cx - 85, cy + 85), (cx - 40, cy + 85), (cx - 40, cy + 140), (cx - 85, cy + 140)],
            [(cx + 40, cy + 85), (cx + 85, cy + 85), (cx + 85, cy + 140), (cx + 40, cy + 140)],
            [(cx - 22, cy + 205), (cx + 22, cy + 205), (cx + 22, cy + 160), (cx - 22, cy + 160)],
        ]

    blinks = [(2.4, (-1, 1)), (6.1, (-1, 1)), (9.3, (1,)), (12.6, (-1, 1))]  # (time, eyes)
    rng = np.random.default_rng(7)
    flick = np.convolve(rng.uniform(0.7, 1.0, int(secs * FPS) + 20), np.ones(4) / 4, mode="same")
    embers = [(random.Random(i).uniform(cx - 200, cx + 200), random.Random(i * 7).uniform(0, 1),
               random.Random(i * 3).uniform(0.6, 1.2)) for i in range(14)]

    def render(t):
        img = bg.copy()
        draw_stars(img, stars, t)
        # ground shadow
        sh = Image.new("L", (W, W), 0)
        ImageDraw.Draw(sh).ellipse([cx - 320, cy + 200, cx + 320, cy + 270], fill=150)
        sh = sh.filter(ImageFilter.GaussianBlur(20))
        img.alpha_composite(Image.composite(Image.new("RGBA", (W, W), (0, 0, 0, 255)),
                                            Image.new("RGBA", (W, W), (0, 0, 0, 0)), sh))
        bob = 10 * math.sin(2 * math.pi * t / 3.0)
        frame = Image.new("RGBA", (W, W), (0, 0, 0, 0))
        frame.alpha_composite(body)
        d = ImageDraw.Draw(frame)
        f = float(flick[int(t * FPS)])
        hole = (int(255 * f), int(200 * f), int(60 * f), 255)
        holes = Image.new("L", (W, W), 0)
        hd = ImageDraw.Draw(holes)
        for side in (-1, 1):
            amt = 1.0
            for bt, eyes in blinks:
                if side in eyes and bt <= t < bt + 0.35:
                    amt = abs((t - bt) / 0.175 - 1) * 0.95 + 0.05
            pts = eye(side, amt)
            d.polygon(pts, fill=hole)
            hd.polygon(pts, fill=255)
        nose = [(cx - 32, cy + 20), (cx + 32, cy + 20), (cx, cy - 30)]
        d.polygon(nose, fill=hole)
        hd.polygon(nose, fill=255)
        m = mouth()
        d.polygon(m, fill=hole)
        hd.polygon(m, fill=255)
        for tooth in teeth():
            d.polygon(tooth, fill=(240, 124, 26, 255))
            hd.polygon(tooth, fill=0)
        # inner light gradient: hotter in the middle of each hole
        frame = frame.transform(frame.size, Image.AFFINE, (1, 0, 0, 0, 1, -bob), Image.BICUBIC)
        holes = holes.transform(holes.size, Image.AFFINE, (1, 0, 0, 0, 1, -bob), Image.BILINEAR)
        img.alpha_composite(glow_layer(holes, (255, 150, 30), 60, 1.6 * f))
        img.alpha_composite(frame)
        img.alpha_composite(glow_layer(holes, (255, 230, 120), 14, 0.9 * f))
        # rising embers
        ed = ImageDraw.Draw(img)
        for ex, ph, sp in embers:
            k = (t * sp * 0.12 + ph) % 1.0
            y = cy - 260 - k * 380
            x = ex + 30 * math.sin(k * 9 + ph * 6)
            a = int(255 * (1 - k))
            r = 4 * S * (1 - k * 0.6)
            ed.ellipse([x - r, y - r, x + r, y + r], fill=(255, 170, 60, a))
        return finish(img)

    audio = to_stereo(wind(secs, 3, 0.12))
    drone = tone(55, secs, harmonics=(0.6, 0.3, 0.15), attack=1.0, release=1.0) * 0.25
    audio += to_stereo(drone)
    rng = np.random.default_rng(5)
    crack = np.zeros(int(secs * SR), np.float32)
    for at in rng.uniform(0, secs, 160):
        n = int(rng.uniform(0.003, 0.012) * SR)
        place(crack, rng.standard_normal(n).astype(np.float32) * np.linspace(1, 0, n), at, rng.uniform(0.1, 0.35))
    audio += to_stereo(crack, 0.1)
    for bt, _ in blinks:  # little "bloop" when it blinks
        place(audio[:, 0], tone(330, 0.18, (1, 0.3), 0.005, 0.12) * np.linspace(1.2, 0.8, int(0.18 * SR)), bt, 0.25)
        place(audio[:, 1], tone(330, 0.18, (1, 0.3), 0.005, 0.12), bt, 0.25)
    encode(path, secs, render, master(audio, secs))


# ---------------------------------------------------------------- clip 2: friendly ghost


def clip_ghost(path):
    secs = 15.0
    bg = radial_bg((40, 30, 90), (6, 5, 20), center=(0.35, 0.3), radius=0.9)
    stars = make_stars(60, 21)
    boo_font = chalkboard_bold(150 * S // 2)
    boos = [3.5, 10.5]

    def ghost_shape(gx, gy, t):
        pts = []
        r = 150
        for i in range(0, 181, 6):  # head arc
            a = math.radians(180 + i)
            pts.append((gx + r * math.cos(a), gy - 40 + r * math.sin(a)))
        pts.append((gx + r, gy + 130))
        for i in range(0, 61):  # wavy hem, right to left
            u = 1 - i / 60
            x = gx - r + 2 * r * u
            y = gy + 150 + 26 * math.sin(u * 4 * math.pi + t * 5)
            pts.append((x, y))
        pts.append((gx - r, gy + 130))
        return pts

    def render(t):
        img = bg.copy()
        draw_stars(img, stars, t)
        # moon glow
        mg = Image.new("L", (W, W), 0)
        ImageDraw.Draw(mg).ellipse([220, 160, 360, 300], fill=255)
        img.alpha_composite(glow_layer(mg, (230, 230, 255), 50, 0.8))
        ImageDraw.Draw(img).ellipse([240, 180, 340, 280], fill=(245, 245, 230, 255))

        gx = W / 2 + 130 * math.sin(2 * math.pi * t / 7.5)
        gy = W * 0.5 + 45 * math.sin(4 * math.pi * t / 7.5)
        tilt = -8 * math.cos(2 * math.pi * t / 7.5)

        layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        mask = Image.new("L", (W, W), 0)
        md = ImageDraw.Draw(mask)
        shape = ghost_shape(gx, gy, t)
        # arms
        wave = math.sin(t * 8) * 25
        arms = [
            (gx - 150, gy + 10, gx - 215, gy - 40 + wave),
            (gx + 150, gy + 30, gx + 200, gy + 50),
        ]
        for x0, y0, x1, y1 in arms:
            d.line([(x0, y0), (x1, y1)], fill=(245, 245, 255, 235), width=56)
            d.ellipse([x1 - 30, y1 - 30, x1 + 30, y1 + 30], fill=(245, 245, 255, 235))
            md.line([(x0, y0), (x1, y1)], fill=255, width=56)
        d.polygon(shape, fill=(245, 245, 255, 235))
        md.polygon(shape, fill=255)
        # shading on the right side
        sh = Image.new("L", (W, W), 0)
        ImageDraw.Draw(sh).ellipse([gx + 40, gy - 150, gx + 200, gy + 180], fill=60)
        sh = sh.filter(ImageFilter.GaussianBlur(40))
        sh = Image.composite(sh, Image.new("L", (W, W), 0), mask)
        shade = Image.new("RGBA", (W, W), (120, 120, 200, 0))
        shade.putalpha(sh)
        layer.alpha_composite(shade)

        blink = any(b <= t % 4.0 < b + 0.16 for b in (1.7,))
        talking = any(b <= t < b + 1.8 for b in boos)
        eh = 8 if blink else 52
        for side in (-1, 1):
            ex = gx + side * 52
            d.ellipse([ex - 22, gy - 75 - eh / 2, ex + 22, gy - 75 + eh / 2], fill=(25, 20, 45, 255))
            if not blink:
                d.ellipse([ex - 9, gy - 90, ex + 3, gy - 78], fill=(255, 255, 255, 255))
            d.ellipse([ex + side * 22 - 22, gy - 20, ex + side * 22 + 22, gy + 4], fill=(255, 160, 190, 150))
        mo = 34 if talking else 14
        d.ellipse([gx - mo * 0.7, gy - 5, gx + mo * 0.7, gy - 5 + mo * 1.3], fill=(25, 20, 45, 255))

        layer = layer.rotate(tilt, resample=Image.BICUBIC, center=(gx, gy))
        mask = mask.rotate(tilt, resample=Image.BILINEAR, center=(gx, gy))
        img.alpha_composite(glow_layer(mask, (170, 200, 255), 70, 0.9))
        img.alpha_composite(layer)

        for b in boos:
            if b <= t < b + 2.2:
                k = (t - b) / 0.45
                s = ease_out_back(k)
                fade = 1 - smooth((t - b - 1.7) / 0.5)
                tl = text_layer("BOO!", boo_font, (255, 140, 0, 255), 10, (40, 10, 60, 255),
                                scale=max(0.05, s), center=(gx + (130 if gx < W / 2 else -130), gy - 260),
                                angle=-10)
                if fade < 1:
                    tl.putalpha(tl.getchannel("A").point(lambda v, f=fade: int(v * f)))
                img.alpha_composite(tl)
        return finish(img)

    audio = to_stereo(wind(secs, 7, 0.15))
    for b in boos:
        f = 260 + 120 * np.sin(np.linspace(0, np.pi, int(1.8 * SR)))
        tt = t_axis(1.8)
        ph = 2 * np.pi * np.cumsum(f * (1 + 0.02 * np.sin(2 * np.pi * 6 * tt))) / SR
        woo = (np.sin(ph) + 0.35 * np.sin(2 * ph) + 0.1 * np.sin(3 * ph)) * np.sin(np.linspace(0, np.pi, len(tt))) ** 0.7
        place(audio[:, 0], woo.astype(np.float32), b, 0.5)
        place(audio[:, 1], woo.astype(np.float32), b + 0.01, 0.5)
    hum = tone(196, secs, (0.5, 0.2), 1.5, 1.5, vibrato=0.01, vib_rate=0.3) * 0.12
    audio += to_stereo(hum)
    encode(path, secs, render, master(audio, secs))


# ---------------------------------------------------------------- clip 3: bats over the moon


def bare_tree(d, x, y, length, angle, width, depth, rnd):
    if depth == 0 or length < 8:
        return
    x2 = x + length * math.cos(angle)
    y2 = y - length * math.sin(angle)
    d.line([(x, y), (x2, y2)], fill=(10, 5, 15, 255), width=max(2, int(width)))
    d.ellipse([x2 - width / 2, y2 - width / 2, x2 + width / 2, y2 + width / 2], fill=(10, 5, 15, 255))
    for da in (rnd.uniform(0.25, 0.6), -rnd.uniform(0.25, 0.6)):
        bare_tree(d, x2, y2, length * rnd.uniform(0.62, 0.78), angle + da, width * 0.68, depth - 1, rnd)


def bat(d, x, y, size, flap, color=(15, 8, 22, 255)):
    s = size
    up = math.sin(flap)  # -1..1
    wing_y = -0.9 * up * s
    for side in (-1, 1):
        pts = [
            (x + side * 0.15 * s, y - 0.1 * s),
            (x + side * 0.7 * s, y + wing_y - 0.25 * s),
            (x + side * 1.25 * s, y + wing_y * 0.9 - 0.05 * s),
            (x + side * 1.05 * s, y + wing_y * 0.5 + 0.2 * s),
            (x + side * 0.8 * s, y + wing_y * 0.4 + 0.08 * s),
            (x + side * 0.55 * s, y + wing_y * 0.3 + 0.3 * s),
            (x + side * 0.15 * s, y + 0.25 * s),
        ]
        d.polygon(pts, fill=color)
    d.ellipse([x - 0.22 * s, y - 0.25 * s, x + 0.22 * s, y + 0.35 * s], fill=color)
    d.ellipse([x - 0.18 * s, y - 0.45 * s, x + 0.18 * s, y - 0.12 * s], fill=color)
    for side in (-1, 1):
        d.polygon([(x + side * 0.05 * s, y - 0.4 * s), (x + side * 0.2 * s, y - 0.65 * s),
                   (x + side * 0.18 * s, y - 0.32 * s)], fill=color)


def clip_bats(path):
    secs = 15.0
    bg = vertical_bg((22, 10, 48), (120, 45, 70))
    stars = make_stars(70, 31, area=lambda x, y: y < W * 0.55)
    moon_c, moon_r = (W * 0.6, W * 0.4), 190

    static = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    mg = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mg).ellipse([moon_c[0] - moon_r, moon_c[1] - moon_r, moon_c[0] + moon_r, moon_c[1] + moon_r], fill=255)
    static.alpha_composite(glow_layer(mg, (255, 240, 190), 110, 1.0))
    d = ImageDraw.Draw(static)
    d.ellipse([moon_c[0] - moon_r, moon_c[1] - moon_r, moon_c[0] + moon_r, moon_c[1] + moon_r], fill=(252, 244, 206, 255))
    rnd = random.Random(4)
    for _ in range(9):
        a, rr = rnd.uniform(0, math.tau), rnd.uniform(0, moon_r * 0.75)
        cr = rnd.uniform(14, 42)
        x, y = moon_c[0] + rr * math.cos(a), moon_c[1] + rr * math.sin(a)
        d.ellipse([x - cr, y - cr, x + cr, y + cr], fill=(232, 222, 180, 255))
    # hill, tree, tombstones
    hill = [(0, W)]
    for i in range(0, W + 1, 20):
        hill.append((i, W * 0.8 + 40 * math.sin(i / 170) - 30 * math.cos(i / 90)))
    hill.append((W, W))
    d.polygon(hill, fill=(10, 5, 15, 255))
    bare_tree(d, W * 0.27, W * 0.83, 170, math.radians(92), 34, 7, random.Random(9))
    for tx, tw, th in [(W * 0.62, 70, 110), (W * 0.75, 56, 84)]:
        ty = W * 0.8
        d.rounded_rectangle([tx - tw / 2, ty - th, tx + tw / 2, ty + 10], radius=tw / 2, fill=(10, 5, 15, 255))

    rng = random.Random(12)
    bats = []
    for _ in range(6):
        bats.append(dict(
            speed=rng.choice([1, 1, 2]),  # laps per clip, so the loop is seamless
            off=rng.uniform(0, 1), y=rng.uniform(W * 0.25, W * 0.6), amp=rng.uniform(20, 70),
            size=rng.uniform(34, 70), flap=rng.uniform(7, 10), dir=rng.choice([-1, 1]), ph=rng.uniform(0, 6)))

    def render(t):
        img = bg.copy()
        draw_stars(img, stars, t)
        img.alpha_composite(static)
        d = ImageDraw.Draw(img)
        for b in sorted(bats, key=lambda b: b["size"]):
            k = (t / secs * b["speed"] + b["off"]) % 1.0
            x = -120 + k * (W + 240)
            if b["dir"] < 0:
                x = W - x
            y = b["y"] + b["amp"] * math.sin(k * math.tau * 2 + b["ph"])
            bat(d, x, y, b["size"], t * b["flap"] + b["ph"])
        return finish(img)

    audio = to_stereo(wind(secs, 11, 0.3))
    for at in (4.0, 11.0):  # distant owl
        for k, f in enumerate((420, 400)):
            hoot = tone(f, 0.45, (1, 0.2), 0.05, 0.25)
            place(audio[:, 0], hoot, at + k * 0.55, 0.22)
            place(audio[:, 1], hoot, at + k * 0.55, 0.3)
    rng = np.random.default_rng(3)
    for at in rng.uniform(0.5, secs - 0.5, 14):  # tiny bat squeaks
        sq = tone(np.float32(rng.uniform(3500, 5200)), 0.05, (1,), 0.005, 0.03)
        place(audio[:, int(rng.integers(0, 2))], sq, at, 0.08)
    encode(path, secs, render, master(audio, secs))


# ---------------------------------------------------------------- clip 4: eyes in the dark


def clip_eyes(path):
    secs = 15.0
    bg = radial_bg((24, 14, 34), (2, 2, 6), radius=0.7)
    rng = np.random.default_rng(42)
    fog = rng.uniform(0, 255, (W // 32, W // 16)).astype(np.uint8)
    fog = Image.fromarray(fog, "L").resize((W * 2, W), Image.BICUBIC).filter(ImageFilter.GaussianBlur(30))
    title = fit_font("Trick or", W * 0.66, 100 * S, stroke=12)
    rnd = random.Random(8)
    colors = [(255, 210, 40), (120, 255, 90), (255, 110, 40), (190, 120, 255), (255, 240, 120)]
    pairs, tries = [], 0
    while len(pairs) < 8 and tries < 500:
        tries += 1
        a, r = rnd.uniform(0, math.tau), rnd.uniform(60, 330)
        x, y = W / 2 + r * math.cos(a), W / 2 + r * math.sin(a)
        if W * 0.27 < y < W * 0.76 and abs(x - W / 2) < 400:
            continue  # keep the middle free for the text
        if any(math.hypot(x - p["x"], y - p["y"]) < 150 for p in pairs):
            continue
        pairs.append(dict(x=x, y=y, size=rnd.uniform(16, 30), col=rnd.choice(colors), appear=rnd.uniform(0.2, 5),
                          blinks=sorted(rnd.uniform(0, secs) for _ in range(4)), look=rnd.uniform(0, 6),
                          slit=rnd.random() < 0.4))

    def render(t):
        img = bg.copy()
        off = int((t / secs) * W)
        fl = fog.crop((off, 0, off + W, W)).point(lambda v: int(v * 0.25))
        img.alpha_composite(Image.composite(Image.new("RGBA", (W, W), (90, 70, 120, 255)),
                                            Image.new("RGBA", (W, W), (0, 0, 0, 0)), fl))
        eyes = Image.new("RGBA", (W, W), (0, 0, 0, 0))
        mask = Image.new("L", (W, W), 0)
        d, md = ImageDraw.Draw(eyes), ImageDraw.Draw(mask)
        glows = []
        for p in pairs:
            vis = smooth((t - p["appear"]) / 0.6)
            if vis <= 0:
                continue
            open_ = 1.0
            for b in p["blinks"]:
                if b <= t < b + 0.22:
                    open_ = abs((t - b) / 0.11 - 1)
            s = p["size"] * S / 2 * 2
            lx = 0.35 * s * math.sin(t * 0.8 + p["look"])
            for side in (-1, 1):
                ex, ey = p["x"] + side * s * 1.6, p["y"]
                h = max(1.5, s * 0.65 * open_)
                col = tuple(int(c * vis) for c in p["col"]) + (255,)
                d.ellipse([ex - s, ey - h, ex + s, ey + h], fill=col)
                md.ellipse([ex - s, ey - h, ex + s, ey + h], fill=int(255 * vis))
                if open_ > 0.3:
                    if p["slit"]:
                        d.ellipse([ex + lx - s * 0.12, ey - h * 0.9, ex + lx + s * 0.12, ey + h * 0.9], fill=(10, 5, 10, 255))
                    else:
                        pr = min(h, s * 0.38)
                        d.ellipse([ex + lx - pr, ey - pr, ex + lx + pr, ey + pr], fill=(10, 5, 10, 255))
            glows.append(p["col"])
        img.alpha_composite(glow_layer(mask, (255, 190, 90), 40, 1.3))
        img.alpha_composite(eyes)
        if t > 7.5:
            k = smooth((t - 7.5) / 1.2)
            for line, dy in (("Trick or", -70), ("Treat!", 70)):
                tl = text_layer(line, title, (255, 150, 20, 255), 12, (30, 8, 40, 255),
                                scale=0.8 + 0.2 * ease_out_back((t - 7.5) / 0.8), center=(W / 2, W / 2 + dy * S))
                a = tl.getchannel("A")
                img.alpha_composite(glow_layer(a, (255, 120, 0), 30, 0.8 * k))
                tl.putalpha(a.point(lambda v: int(v * k)))
                img.alpha_composite(tl)
        return finish(img)

    audio = to_stereo(tone(55, secs, (0.5, 0.25), 2, 2) * 0.2)
    rng = np.random.default_rng(9)
    for start in np.arange(0.3, secs - 1, 0.9):  # crickets
        if rng.random() < 0.75:
            for k in range(3):
                ch = tone(np.float32(4300 + rng.uniform(-150, 150)), 0.035, (1,), 0.004, 0.02)
                place(audio[:, int(rng.integers(0, 2))], ch, start + k * 0.06, 0.12)
    for p in pairs:  # soft pop as each pair of eyes opens
        place(audio[:, 0 if p["x"] < W / 2 else 1], tone(np.float32(520 + p["size"] * 4), 0.12, (1, 0.4), 0.004, 0.09), p["appear"], 0.18)
    place(audio[:, 0], tone(196, 1.4, (1, 0.5, 0.25), 0.05, 0.8), 7.5, 0.25)
    place(audio[:, 1], tone(247, 1.4, (1, 0.5, 0.25), 0.05, 0.8), 7.6, 0.25)
    encode(path, secs, render, master(audio, secs))


# ---------------------------------------------------------------- clip 5: bubbling cauldron


def clip_cauldron(path):
    secs = 15.0
    bg = radial_bg((60, 20, 70), (6, 3, 12), center=(0.5, 0.6), radius=0.75)
    cx, rim_y = W / 2, W * 0.42
    rnd = random.Random(5)
    bubbles = [dict(x=rnd.uniform(-170, 170), ph=rnd.uniform(0, 1), sp=rnd.uniform(0.5, 1.1), r=rnd.uniform(14, 32))
               for _ in range(14)]
    puffs = [dict(x=rnd.uniform(-120, 120), ph=rnd.uniform(0, 1), r=rnd.uniform(40, 80)) for _ in range(9)]
    flames = [dict(x=rnd.uniform(-170, 170), h=rnd.uniform(90, 150), w=rnd.uniform(50, 80), ph=rnd.uniform(0, 6))
              for _ in range(9)]

    def flame(d, x, base, w, h, t, ph, col):
        tip = 18 * math.sin(t * 9 + ph)
        hh = h * (0.8 + 0.2 * math.sin(t * 13 + ph * 2))
        d.polygon([(x - w / 2, base), (x - w / 4, base - hh * 0.5), (x + tip, base - hh),
                   (x + w / 4, base - hh * 0.45), (x + w / 2, base)], fill=col)

    def render(t):
        img = bg.copy()
        fire = Image.new("RGBA", (W, W), (0, 0, 0, 0))
        fd = ImageDraw.Draw(fire)
        fm = Image.new("L", (W, W), 0)
        fmd = ImageDraw.Draw(fm)
        base = rim_y + 390
        for f in flames:
            for scale, col in ((1.0, (230, 60, 20, 255)), (0.72, (255, 140, 20, 255)), (0.42, (255, 230, 90, 255))):
                flame(fd, cx + f["x"], base, f["w"] * scale, f["h"] * scale, t, f["ph"], col)
            flame(fmd, cx + f["x"], base, f["w"], f["h"], t, f["ph"], 255)
        img.alpha_composite(glow_layer(fm, (255, 110, 20), 60, 1.2 + 0.2 * math.sin(t * 11)))
        img.alpha_composite(fire)
        # logs
        d = ImageDraw.Draw(img)
        d.rounded_rectangle([cx - 220, base - 10, cx + 220, base + 26], radius=18, fill=(70, 35, 20, 255))
        # cauldron body
        d.ellipse([cx - 290, rim_y - 120, cx + 290, rim_y + 300], fill=(22, 20, 28, 255))
        d.ellipse([cx - 240, rim_y - 60, cx - 120, rim_y + 220], fill=(36, 34, 46, 255))  # sheen
        for lx in (-200, 0, 200):
            d.polygon([(cx + lx - 22, rim_y + 260), (cx + lx + 22, rim_y + 260), (cx + lx + 12, rim_y + 330),
                       (cx + lx - 12, rim_y + 330)], fill=(22, 20, 28, 255))
        # rim and potion
        d.ellipse([cx - 300, rim_y - 70, cx + 300, rim_y + 40], fill=(48, 46, 58, 255))
        pot = Image.new("L", (W, W), 0)
        ImageDraw.Draw(pot).ellipse([cx - 260, rim_y - 52, cx + 260, rim_y + 22], fill=255)
        img.alpha_composite(glow_layer(pot, (90, 255, 80), 90, 1.0 + 0.15 * math.sin(t * 3)))
        d = ImageDraw.Draw(img)
        d.ellipse([cx - 260, rim_y - 52, cx + 260, rim_y + 22], fill=(70, 200, 50, 255))
        sw = 40 * math.sin(t * 1.3)
        d.ellipse([cx - 150 + sw, rim_y - 34, cx + 60 + sw, rim_y], fill=(120, 240, 90, 255))
        # bubbles: rise a little, swell, pop
        for b in bubbles:
            k = (t * b["sp"] + b["ph"]) % 1.0
            x = cx + b["x"]
            y = rim_y - 20 - k * 70
            r = b["r"] * (0.4 + k)
            if k < 0.92:
                d.ellipse([x - r, y - r, x + r, y + r], fill=(110, 235, 80, 255), outline=(170, 255, 140, 255), width=4)
                d.ellipse([x - r * 0.5, y - r * 0.6, x - r * 0.1, y - r * 0.2], fill=(220, 255, 210, 255))
            else:
                for a in range(0, 360, 60):
                    rr = r * 1.4
                    d.ellipse([x + rr * math.cos(math.radians(a)) - 5, y + rr * math.sin(math.radians(a)) - 5,
                               x + rr * math.cos(math.radians(a)) + 5, y + rr * math.sin(math.radians(a)) + 5],
                              fill=(170, 255, 140, 255))
        # steam
        steam = Image.new("RGBA", (W, W), (0, 0, 0, 0))
        sd = ImageDraw.Draw(steam)
        for p in puffs:
            k = (t / 5 + p["ph"]) % 1.0
            x = cx + p["x"] + 40 * math.sin(k * 6 + p["ph"] * 9)
            y = rim_y - 60 - k * 360
            r = p["r"] * (0.6 + k * 1.2)
            a = int(110 * math.sin(math.pi * k))
            sd.ellipse([x - r, y - r, x + r, y + r], fill=(170, 255, 170, a))
        steam = steam.filter(ImageFilter.GaussianBlur(12))
        img.alpha_composite(steam)
        return finish(img)

    rng = np.random.default_rng(13)
    audio = np.zeros((int(secs * SR), 2), np.float32)
    for at in rng.uniform(0, secs, 70):  # bloops
        dur = rng.uniform(0.05, 0.12)
        f0 = rng.uniform(180, 320)
        tt = t_axis(dur)
        ph = 2 * np.pi * np.cumsum(f0 * (1 + 2.5 * tt / dur)) / SR
        bl = (np.sin(ph) * np.sin(np.pi * tt / dur)).astype(np.float32)
        place(audio[:, int(rng.integers(0, 2))], bl, at, rng.uniform(0.2, 0.45))
    crack = np.zeros(int(secs * SR), np.float32)
    for at in rng.uniform(0, secs, 220):
        n = int(rng.uniform(0.002, 0.01) * SR)
        place(crack, rng.standard_normal(n).astype(np.float32) * np.linspace(1, 0, n), at, rng.uniform(0.05, 0.25))
    audio += to_stereo(crack)
    audio += to_stereo(wind(secs, 17, 0.1))
    encode(path, secs, render, master(audio, secs))


# ---------------------------------------------------------------- clip 6: Happy Halloween title


def candy_corn(d, x, y, s, angle):
    def rot(px, py):
        ca, sa = math.cos(angle), math.sin(angle)
        return (x + px * ca - py * sa, y + px * sa + py * ca)

    bands = [((255, 210, 40), 0.0, 0.42), ((255, 130, 20), 0.42, 0.78), ((250, 245, 235), 0.78, 1.0)]
    for col, a, b in bands:
        def edge(k):
            half = s * 0.55 * (1 - k)
            yk = s * 0.6 - k * s * 1.3
            return half, yk
        ha, ya = edge(a)
        hb, yb = edge(b)
        d.polygon([rot(-ha, ya), rot(ha, ya), rot(hb, yb), rot(-hb, yb)], fill=col + (255,))


def mini_pumpkin(d, x, y, s, angle):
    d.ellipse([x - s, y - s * 0.8, x + s, y + s * 0.8], fill=(240, 120, 20, 255), outline=(180, 80, 10, 255), width=3)
    d.ellipse([x - s * 0.45, y - s * 0.8, x + s * 0.45, y + s * 0.8], outline=(200, 90, 10, 255), width=3)
    sx = x + math.sin(angle) * s * 0.3
    d.rectangle([sx - s * 0.12, y - s * 1.05, sx + s * 0.12, y - s * 0.7], fill=(90, 110, 40, 255))


def clip_title(path):
    secs = 16.0
    bg = radial_bg((215, 100, 20), (40, 8, 60), center=(0.5, 0.5), radius=0.68)
    stars = make_stars(40, 41)
    # the circle is narrower away from the middle, so size each line to its chord
    f = fit_font("Halloween!", W * 0.78, 140 * S, stroke=14)
    f_small = fit_font("Happy", W * 0.6, int(f.size * 0.85), stroke=14)
    rnd = random.Random(3)
    falling = [dict(x=rnd.uniform(60, W - 60), ph=rnd.uniform(0, 1), sp=rnd.choice([1, 2]), s=rnd.uniform(34, 56),
                    kind=rnd.choice(["corn", "corn", "pumpkin"]), spin=rnd.uniform(-2, 2)) for _ in range(16)]

    def letters_layer(text, fnt, cy, t, delay):
        layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        widths = [d.textlength(ch, font=fnt) for ch in text]
        x = W / 2 - sum(widths) / 2
        for i, (ch, w) in enumerate(zip(text, widths)):
            k = t - delay - i * 0.08
            pop = ease_out_back(k / 0.5) if k < 0.5 else 1.0
            if k <= 0:
                x += w
                continue
            bounce = -abs(math.sin(t * 3 - i * 0.45)) * 22 if t > 2.5 else 0
            yy = cy + bounce + (1 - min(1, pop)) * 60
            d.text((x + w / 2, yy), ch, font=fnt, fill=(255, 150, 20, 255), anchor="mm", stroke_width=14,
                   stroke_fill=(40, 8, 50, 255))
            x += w
        return layer

    def render(t):
        img = bg.copy()
        draw_stars(img, stars, t)
        d = ImageDraw.Draw(img)
        for it in falling:
            k = (t / secs * it["sp"] + it["ph"]) % 1.0
            y = -60 + k * (W + 120)
            x = it["x"] + 30 * math.sin(k * 8 + it["ph"] * 5)
            ang = t * it["spin"]
            if it["kind"] == "corn":
                candy_corn(d, x, y, it["s"], ang)
            else:
                mini_pumpkin(d, x, y, it["s"] * 0.8, ang)
        l1 = letters_layer("Happy", f_small, W * 0.4, t, 0.2)
        l2 = letters_layer("Halloween!", f, W * 0.6, t, 0.8)
        for layer in (l1, l2):
            img.alpha_composite(glow_layer(layer.getchannel("A"), (255, 200, 60), 28, 0.7))
            img.alpha_composite(layer)
        return finish(img)

    # original little spooky-cheerful tune: Am - F - G - E, two times
    notes = {"E3": 164.81, "G#3": 207.65, "A3": 220.0, "B3": 246.94, "C4": 261.63, "D4": 293.66, "E4": 329.63,
             "F3": 174.61, "G3": 196.0, "A4": 440.0, "G4": 392.0, "F4": 349.23}
    bars = [["A3", "C4", "E4", "A4", "E4", "C4", "E4", "C4"],
            ["F3", "A3", "C4", "F4", "C4", "A3", "C4", "A3"],
            ["G3", "B3", "D4", "G4", "D4", "B3", "D4", "B3"],
            ["E3", "G#3", "B3", "E4", "B3", "G#3", "B3", "G#3"]]
    bass = ["A3", "F3", "G3", "E3"]
    audio = np.zeros((int(secs * SR), 2), np.float32)
    step = 0.25
    t0 = 0.0
    for rep in range(2):
        for bi, bar in enumerate(bars):
            bstart = t0 + (rep * 4 + bi) * 2.0
            bnote = tone(notes[bass[bi]] / 2, 1.9, (1, 0.5, 0.2), 0.02, 0.4)
            place(audio[:, 0], bnote, bstart, 0.35)
            place(audio[:, 1], bnote, bstart, 0.35)
            for ni, n in enumerate(bar):
                nt = tone(notes[n] * 2, 0.24, (1, 0.45, 0.3, 0.15), 0.004, 0.18)
                pan = 0 if ni % 2 == 0 else 1
                place(audio[:, pan], nt, bstart + ni * step, 0.3)
                place(audio[:, 1 - pan], nt, bstart + ni * step, 0.18)
            for k in range(4):  # soft tick on each beat
                rng = np.random.default_rng(bi * 10 + k)
                n = int(0.03 * SR)
                tick = rng.standard_normal(n).astype(np.float32) * np.linspace(1, 0, n)
                place(audio[:, 0], tick, bstart + k * 0.5, 0.08)
                place(audio[:, 1], tick, bstart + k * 0.5, 0.08)
    encode(path, secs, render, master(audio, secs, peak=0.55))


CLIPS = [
    ("01-happy-halloween.mp4", clip_title, "Happy Halloween"),
    ("02-jack-o-lantern.mp4", clip_pumpkin, "Jack-o'-lantern"),
    ("03-friendly-ghost.mp4", clip_ghost, "Friendly ghost"),
    ("04-bats-and-moon.mp4", clip_bats, "Bats and moon"),
    ("05-eyes-in-the-dark.mp4", clip_eyes, "Eyes in the dark"),
    ("06-bubbling-cauldron.mp4", clip_cauldron, "Bubbling cauldron"),
]


def main():
    out_dir = sys.argv[1]
    only = set(sys.argv[2:])
    os.makedirs(out_dir, exist_ok=True)
    for fname, fn, _title in CLIPS:
        if only and not any(o in fname for o in only):
            continue
        print(f"rendering {fname}", flush=True)
        fn(os.path.join(out_dir, fname))
    meta = {"name": "Halloween", "emoji": "🎃", "builtin": True,
            "note": "Original animations made for the crystal ball",
            "titles": {f: t for f, _, t in CLIPS}}
    with open(os.path.join(out_dir, "theme.json"), "w") as fh:
        json.dump(meta, fh, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
