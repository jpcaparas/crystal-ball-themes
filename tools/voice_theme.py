"""Render a voiced theme (characters that talk) for the crystal ball.

A theme script (tools/scripts/*.json) lists scenes: a line of dialogue, a voice, an acting
style, and the art to show. This tool:

  1. makes any missing art with Gemini (Nano Banana 2.1)        -> assets/sources/<id>/art/<key>.jpg
  2. makes any missing voices with Gemini 3.8 Flash TTS         -> assets/sources/<id>/voice/<scene>.flac
  3. renders each scene in the ball's format                    -> assets/themes/<id>/<scene>.mp4

Generated art and voices are committed, so step 3 can be re-run offline and for free.
Scenes are animated with a slow push-in, effects (fog, bats, sparkles...), a caption, and a
glow that pulses with the voice so the character feels alive.

Usage:
  uv run --with pillow --with numpy python tools/voice_theme.py tools/scripts/monster-parade.json
  ... --only dracula          render just matching scenes
  ... --draft --out /tmp/x    placeholder art + macOS `say` voices (no API key needed)
"""

import argparse
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import zlib

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_halloween as mh  # noqa: E402  (shared drawing, audio and encoding helpers)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, FPS, SR = mh.W, mh.FPS, mh.SR
LEAD, TAIL, MIN_SECS = 0.9, 1.6, 7.0
TAG_RE = re.compile(r"<[^>]+>")


def seed_of(name):
    return zlib.crc32(name.encode())  # stable across runs, unlike hash()


# ---------------------------------------------------------------- script


def load_script(path):
    with open(path, encoding="utf-8") as fh:
        s = json.load(fh)
    art = dict(s.get("art", {}))
    for sc in s["scenes"]:
        if "art" in sc:  # one picture per scene, prompt inline
            art[sc["file"]] = sc.pop("art")
            sc["shots"] = [sc["file"]]
        sc.setdefault("voice", s.get("voice", "Kore"))
        sc.setdefault("style", s.get("style"))
        sc.setdefault("fx", s.get("fx", ["sparkles"] if s.get("ambience") == "mystic" else ["fog"]))
    s["art"] = art
    return s


# ---------------------------------------------------------------- sources


def ensure_art(script, key, path, draft):
    if os.path.exists(path):
        return
    if draft:
        return draft_art(script, key, path)
    from gemini_media import generate_image

    print(f"  art: {key}", flush=True)
    generate_image(f"{script['art_style']} {script['art'][key]}", path)


def ensure_voice(scene, path, draft):
    if os.path.exists(path):
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, "voice.wav")
        if draft:
            aiff = os.path.join(tmp, "voice.aiff")
            subprocess.run(["say", "-o", aiff, TAG_RE.sub(" ", scene["line"])], check=True)
            raw = aiff
        else:
            from gemini_media import generate_speech

            print(f"  voice: {scene['file']} ({scene['voice']})", flush=True)
            generate_speech(scene["line"], raw, voice=scene["voice"], style=scene.get("style"))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw, "-c:a", "flac", path], check=True)


def draft_art(script, key, path):
    """Stand-in picture: gradient, the theme emoji, and the art key. Only for testing."""
    img = mh.radial_bg((90, 40, 120), (10, 5, 20), radius=0.7).convert("RGB")
    d = ImageDraw.Draw(img)
    try:
        emoji = ImageFont.truetype("/System/Library/Fonts/Apple Color Emoji.ttc", 160)
        tile = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
        ImageDraw.Draw(tile).text((100, 100), script["emoji"], font=emoji, anchor="mm", embedded_color=True)
        tile = tile.resize((520, 520), Image.LANCZOS)
        img.paste(tile, ((W - 520) // 2, int(W * 0.18)), tile)
    except OSError:
        pass
    d.text((W / 2, W * 0.78), key, font=mh.chalkboard_bold(60), fill=(255, 220, 160), anchor="mm")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, quality=90)


def read_voice(path):
    """Voice as float32 stereo at 44.1 kHz."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).copy()


def envelope(voice, n_frames, offset):
    """0..1 loudness per video frame, smoothed, aligned to where the voice starts."""
    mono = np.abs(voice).mean(axis=1)
    per = SR // FPS
    env = np.zeros(n_frames, np.float32)
    start = int(offset * FPS)
    for i in range(n_frames - start):
        seg = mono[i * per : (i + 1) * per]
        if not len(seg):
            break
        env[start + i] = float(np.sqrt((seg ** 2).mean()))
    if env.max() > 0:
        env /= env.max()
    return np.convolve(env, np.ones(3) / 3, mode="same")


# ---------------------------------------------------------------- effects


class Effects:
    def __init__(self, names, secs, seed):
        self.names = set(names)
        rnd = random.Random(seed)
        self.secs = secs
        self.bats = [dict(off=rnd.random(), y=rnd.uniform(W * 0.1, W * 0.2), amp=rnd.uniform(8, 22),
                          size=rnd.uniform(20, 34), dir=rnd.choice([-1, 1]), ph=rnd.uniform(0, 6)) for _ in range(4)]
        self.motes = [(rnd.uniform(0, W), rnd.uniform(0, 1), rnd.uniform(0.4, 1.2), rnd.uniform(2, 5)) for _ in range(40)]
        self.sparkles = [(rnd.uniform(W * 0.15, W * 0.85), rnd.uniform(W * 0.12, W * 0.8), rnd.uniform(0, 6),
                          rnd.uniform(0.8, 2.0)) for _ in range(26)]
        self.flashes = sorted(rnd.uniform(1.0, max(1.5, secs - 1.5)) for _ in range(2))
        fog = np.random.default_rng(seed).uniform(0, 255, (W // 40, W // 20)).astype(np.uint8)
        self.fog = Image.fromarray(fog, "L").resize((W * 2, W), Image.BICUBIC).filter(ImageFilter.GaussianBlur(40))

    def draw(self, img, t):
        if "fog" in self.names:
            off = int((t / self.secs) * W * 0.6)
            a = self.fog.crop((off, 0, off + W, W)).point(lambda v: int(max(0, v - 90) * 0.9))
            # keep fog low, around the character's feet and the edges
            grad = Image.linear_gradient("L").resize((W, W)).point(lambda v: int(v * 0.9))
            a = Image.composite(a, Image.new("L", (W, W), 0), grad)
            img.alpha_composite(Image.composite(Image.new("RGBA", (W, W), (200, 200, 230, 255)),
                                                Image.new("RGBA", (W, W), (0, 0, 0, 0)), a))
        d = ImageDraw.Draw(img)
        if "bats" in self.names:
            for b in self.bats:
                k = (t / self.secs + b["off"]) % 1.0
                x = -80 + k * (W + 160)
                x = W - x if b["dir"] < 0 else x
                mh.bat(d, x, b["y"] + b["amp"] * math.sin(k * 12 + b["ph"]), b["size"], t * 9 + b["ph"])
        if "embers" in self.names or "dust" in self.names:
            col = (255, 160, 60) if "embers" in self.names else (230, 210, 170)
            for x, ph, sp, r in self.motes:
                k = (t * sp * 0.08 + ph) % 1.0
                y = W * (1 - k) if "embers" in self.names else W * (0.2 + 0.6 * ((ph + t * 0.02 * sp) % 1))
                xx = x + 25 * math.sin(k * 8 + ph * 6)
                a = int(220 * math.sin(math.pi * k))
                d.ellipse([xx - r, y - r, xx + r, y + r], fill=col + (a,))
        if "sparkles" in self.names:
            for x, y, ph, sp in self.sparkles:
                a = max(0.0, math.sin(t * sp * 2 + ph))
                if a < 0.05:
                    continue
                r = 10 * a
                c = (255, 240, 200, int(255 * a))
                d.line([(x - r, y), (x + r, y)], fill=c, width=3)
                d.line([(x, y - r), (x, y + r)], fill=c, width=3)
        if "moon-glow" in self.names:
            g = Image.new("L", (W, W), 0)
            ImageDraw.Draw(g).ellipse([W * 0.55, W * 0.05, W * 0.95, W * 0.45], fill=int(90 + 50 * math.sin(t * 1.5)))
            img.alpha_composite(mh.glow_layer(g, (230, 240, 255), 90, 0.9))
        if "lightning" in self.names:
            for ft in self.flashes:
                if ft <= t < ft + 0.35:
                    k = 1 - (t - ft) / 0.35
                    flick = 1.0 if (t - ft) < 0.06 or 0.12 < (t - ft) < 0.18 else 0.4
                    img.alpha_composite(Image.new("RGBA", (W, W), (220, 230, 255, int(150 * k * flick))))


# ---------------------------------------------------------------- render


def prepare_shot(path):
    img = Image.open(path).convert("RGB")
    side = min(img.size)
    img = img.crop(((img.width - side) // 2, (img.height - side) // 2, (img.width + side) // 2, (img.height + side) // 2))
    return img.resize((int(W * 1.18), int(W * 1.18)), Image.LANCZOS).convert("RGBA")


def place_shot(shot, zoom, pan):
    s = int(shot.width * zoom / 1.18)
    scaled = shot.resize((s, s), Image.BILINEAR)
    x = (W - s) / 2 + pan[0]
    y = (W - s) / 2 + pan[1]
    frame = Image.new("RGBA", (W, W), (0, 0, 0, 255))
    frame.alpha_composite(scaled, (int(x), int(y)))
    return frame


def render_scene(script, scene, art_paths, voice_path, out_path):
    voice = read_voice(voice_path)
    voice_secs = len(voice) / SR
    secs = max(MIN_SECS, LEAD + voice_secs + TAIL)
    n = int(round(secs * FPS))
    env = envelope(voice, n, LEAD)
    shots = [prepare_shot(art_paths[k]) for k in scene["shots"]]
    switch = LEAD + voice_secs * 0.42 if len(shots) > 1 else None  # fortunes: reveal the vision
    fx = Effects(scene["fx"], secs, seed_of(scene["file"]))
    cap_font = mh.fit_font(scene["title"], W * 0.7, 64 * mh.S, stroke=10)  # circle is ~0.75 W wide here
    mystic = script.get("ambience") == "mystic"
    glow_col = (190, 120, 255) if mystic else (255, 160, 60)

    def render(t):
        i = min(n - 1, int(t * FPS))
        e = float(env[i])
        zoom = 1.0 + 0.1 * (t / secs) + 0.015 * e
        pan = (12 * math.sin(t * 0.35), -10 * (t / secs))
        if switch is None:
            img = place_shot(shots[0], zoom, pan)
        else:
            a = mh.smooth((t - switch) / 0.9)
            if a <= 0:
                img = place_shot(shots[0], zoom, pan)
            elif a >= 1:
                img = place_shot(shots[1], 1.02 + 0.06 * ((t - switch) / (secs - switch)) + 0.015 * e, (0, 0))
            else:
                # swirl of mist: blur out of Zara, blur into the vision
                a_img = place_shot(shots[0], zoom + 0.15 * a, pan).filter(ImageFilter.GaussianBlur(18 * a))
                b_img = place_shot(shots[1], 1.2 - 0.18 * a, (0, 0)).filter(ImageFilter.GaussianBlur(18 * (1 - a)))
                img = Image.blend(a_img, b_img, a)
                img = ImageEnhance.Brightness(img).enhance(1 + 0.5 * math.sin(math.pi * a))
        # glow that breathes with the voice
        g = Image.new("L", (W, W), 0)
        ImageDraw.Draw(g).ellipse([W * 0.2, W * 0.3, W * 0.8, W * 0.95], fill=int(120 * e))
        img.alpha_composite(mh.glow_layer(g, glow_col, 120, 0.6))
        fx.draw(img, t)
        k = mh.smooth((t - 0.3) / 0.6) * (1 - mh.smooth((t - (secs - 0.6)) / 0.5))
        if k > 0:
            tl = mh.text_layer(scene["title"], cap_font, (255, 236, 200, 255), 10, (25, 10, 35, 255),
                               center=(W / 2, W * 0.83))
            tl.putalpha(tl.getchannel("A").point(lambda v: int(v * k)))
            img.alpha_composite(tl)
        return mh.finish(img)

    audio = np.zeros((int(secs * SR), 2), np.float32)
    if mystic:
        for f in (220.0, 277.18, 329.63):  # soft A-major shimmer pad
            pad = mh.tone(f, secs, (0.6, 0.2), 1.0, 1.0, vibrato=0.004, vib_rate=0.25)
            audio += mh.to_stereo(pad * 0.05)
        for k, f in enumerate((1318.5, 1567.98, 1975.53, 2637.0)):  # chime
            mh.place(audio[:, k % 2], mh.tone(f, 1.2, (1, 0.3), 0.003, 1.0), 0.05 + k * 0.12, 0.08)
    else:
        audio += mh.to_stereo(mh.wind(secs, seed_of(scene["file"]) & 0xFF, 0.08))
        audio += mh.to_stereo(mh.tone(55, secs, (0.5, 0.25), 1.0, 1.0) * 0.06)
        mh.place(audio[:, 0], mh.tone(82.4, 1.4, (1, 0.5, 0.25), 0.01, 1.0), 0.0, 0.25)
        mh.place(audio[:, 1], mh.tone(82.4, 1.4, (1, 0.5, 0.25), 0.01, 1.0), 0.0, 0.25)
    peak = np.abs(voice).max() or 1.0
    i = int(LEAD * SR)
    j = min(len(audio), i + len(voice))
    audio[i:j] += voice[: j - i] / peak * 0.9
    mh.encode(out_path, secs, render, mh.master(audio, secs, peak=0.8, fade=0.25))


# ---------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("script")
    ap.add_argument("--out", help="output folder (default assets/themes/<id>)")
    ap.add_argument("--only", help="only scenes whose file name contains this")
    ap.add_argument("--draft", action="store_true", help="placeholder art and macOS voices; never calls the API")
    args = ap.parse_args()

    script = load_script(args.script)
    sid = script["id"]
    out_dir = args.out or os.path.join(REPO, "assets", "themes", sid)
    src = os.path.join(args.out, "_draft-sources") if args.draft else os.path.join(REPO, "assets", "sources", sid)
    if args.draft and not args.out:
        sys.exit("--draft needs --out, so drafts never land in the real theme folders")
    os.makedirs(out_dir, exist_ok=True)

    scenes = [s for s in script["scenes"] if not args.only or args.only in s["file"]]
    art_paths = {}
    for sc in scenes:
        for key in sc["shots"]:
            art_paths[key] = os.path.join(src, "art", f"{key}.jpg")
            ensure_art(script, key, art_paths[key], args.draft)
        ensure_voice(sc, os.path.join(src, "voice", f"{sc['file']}.flac"), args.draft)

    for sc in scenes:
        print(f"rendering {sc['file']}.mp4", flush=True)
        render_scene(script, sc, art_paths, os.path.join(src, "voice", f"{sc['file']}.flac"),
                     os.path.join(out_dir, f"{sc['file']}.mp4"))

    meta = {"name": script["name"], "emoji": script["emoji"], "note": script["note"],
            "titles": {f"{s['file']}.mp4": s["title"] for s in script["scenes"]},
            "credits": "Art: Gemini Nano Banana 2.1. Voices: Gemini 3.8 Flash TTS."}
    with open(os.path.join(out_dir, "theme.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    if args.draft:
        shutil.rmtree(src, ignore_errors=True)


if __name__ == "__main__":
    main()
