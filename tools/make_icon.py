"""Make the app icon from the jack-o'-lantern clip, drawn at full resolution.

Usage: uv run --with pillow --with numpy python tools/make_icon.py assets/icon
Writes icon.png (1024 px) and icon.icns (via macOS iconutil).
"""

import os
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(__file__))
import make_halloween as mh  # noqa: E402

SIZE = 1024


def render_pumpkin():
    frames = {}
    mh.finish = lambda img: img.convert("RGB")  # keep the 2x canvas instead of shrinking to 480
    mh.encode = lambda path, secs, render, audio: frames.setdefault("img", render(1.0))
    mh.clip_pumpkin("unused.mp4")
    return frames["img"]


def main():
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    art = render_pumpkin().resize((SIZE - 120, SIZE - 120), Image.LANCZOS)

    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(icon)
    d.ellipse([40, 40, SIZE - 40, SIZE - 40], fill=(12, 6, 20, 255))  # the ball's dark rim
    mask = Image.new("L", art.size, 0)
    ImageDraw.Draw(mask).ellipse([0, 0, art.width - 1, art.height - 1], fill=255)
    icon.paste(art, (60, 60), mask)
    # soft glass highlight, kept inside the ball
    glint = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(glint).ellipse([230, 150, 470, 300], fill=60)
    glint = glint.filter(ImageFilter.GaussianBlur(40))
    shine = Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 0))
    shine.putalpha(glint)
    icon.alpha_composite(shine)

    png = os.path.join(out_dir, "icon.png")
    icon.save(png)
    iconset = os.path.join(out_dir, "icon.iconset")
    shutil.rmtree(iconset, ignore_errors=True)
    os.makedirs(iconset)
    for px in (16, 32, 64, 128, 256, 512):
        icon.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, f"icon_{px}x{px}.png"))
        icon.resize((px * 2, px * 2), Image.LANCZOS).save(os.path.join(iconset, f"icon_{px}x{px}@2x.png"))
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(out_dir, "icon.icns")], check=True)
    shutil.rmtree(iconset)
    print("wrote", png, "and icon.icns")


if __name__ == "__main__":
    main()
