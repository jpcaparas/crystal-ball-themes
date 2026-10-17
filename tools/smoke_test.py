"""Check every theme tool end to end, without calling any API.

Renders one clip with each tool into a temporary folder (voiced tools in --draft mode, which uses
placeholder art and the macOS `say` voice), then checks each file is in the ball's exact format.

Usage: npm run test:tools
"""

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "scripts")


def run(*args):
    subprocess.run([sys.executable, *args], check=True, stdout=subprocess.DEVNULL)


def check(path):
    info = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", path],
        check=True, capture_output=True, text=True).stdout)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    a = next(s for s in info["streams"] if s["codec_type"] == "audio")
    problems = []
    if (v["codec_name"], v.get("profile"), v["width"], v["height"], v["pix_fmt"]) != ("h264", "Constrained Baseline", 480, 480, "yuv420p"):
        problems.append(f"video is {v['codec_name']} {v.get('profile')} {v['width']}x{v['height']} {v['pix_fmt']}")
    if v.get("level") != 30 or v["r_frame_rate"] != "30/1":
        problems.append(f"video level {v.get('level')} at {v['r_frame_rate']} fps")
    if (a["codec_name"], int(a["sample_rate"]), a["channels"]) != ("mp3", 44100, 2):
        problems.append(f"audio is {a['codec_name']} {a['sample_rate']} Hz x{a['channels']}")
    return problems


def main():
    with tempfile.TemporaryDirectory() as d:
        jobs = [
            ("drawn (make_halloween)", lambda: run(os.path.join(HERE, "make_halloween.py"), f"{d}/halloween", "02-jack")),
            ("voiced (voice_theme, one picture)", lambda: run(os.path.join(HERE, "voice_theme.py"), os.path.join(SCRIPTS, "monster-parade.json"),
                                                              "--draft", "--out", f"{d}/monsters", "--only", "07-")),
            ("voiced (voice_theme, two pictures)", lambda: run(os.path.join(HERE, "voice_theme.py"), os.path.join(SCRIPTS, "fortune-teller.json"),
                                                               "--draft", "--out", f"{d}/fortunes", "--only", "02-")),
            ("talking head (spirit_theme)", lambda: run(os.path.join(HERE, "spirit_theme.py"), os.path.join(SCRIPTS, "spirit-in-the-ball.json"),
                                                        "--draft", "--out", f"{d}/spirit", "--only", "04-")),
            ("talking head, moody look (spirit_theme)", lambda: run(os.path.join(HERE, "spirit_theme.py"),
                                                                    os.path.join(SCRIPTS, "midnight-seance.json"), "--draft", "--out", f"{d}/seance")),
        ]
        failed = 0
        for name, job in jobs:
            print(f"… {name}", flush=True)
            job()
        for sub in sorted(os.listdir(d)):
            for f in sorted(os.listdir(os.path.join(d, sub))):
                if f.endswith(".mp4"):
                    problems = check(os.path.join(d, sub, f))
                    print(f"{'✗' if problems else '✓'} {sub}/{f}" + (f": {'; '.join(problems)}" if problems else ""))
                    failed += bool(problems)
        if failed:
            sys.exit(f"{failed} clip(s) are not in the ball's format")
        print("All tool outputs match the ball's format.")


if __name__ == "__main__":
    main()
