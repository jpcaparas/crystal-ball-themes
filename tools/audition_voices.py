"""Audition voices for a theme script before generating every line.

Says the script's first line (or --line) in each voice, then asks a Gemini audio model how the speaker
comes across: apparent age (averaged over --times listens), gender and a short description. Useful because prebuilt voices often
sound younger than their names suggest. Samples are saved so you can listen to them yourself.

Needs a Gemini key (see docs/themes.md). Costs one voice line and one short analysis per voice.

Usage:
  python3 tools/audition_voices.py tools/scripts/midnight-seance.json Vindemiatrix,Gacrux,Sulafat
  ... --line "Hello there"   say something else
  ... --style "..."           try a different acting direction
  ... --out /tmp/voices      where to save the samples (default: a temporary folder)
"""

import argparse
import base64
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gemini_media as g  # noqa: E402

LISTENER = os.environ.get("CRYSTAL_BALL_LISTEN_MODEL", "gemini-3.8-flash")


def describe(path):
    data = base64.b64encode(open(path, "rb").read()).decode()
    body = {"model": LISTENER, "input": [{"type": "user_input", "content": [
        {"type": "text", "text": "Listen to this speaker. Judge only from the voice. Reply only with JSON: "
                                 '{"age_range": "e.g. 50-55", "gender": "...", "description": "under 12 words"}'},
        {"type": "audio", "data": data, "mime_type": "audio/wav"},
    ]}]}
    texts = []

    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "text" and isinstance(node.get("text"), str):
                texts.append(node["text"])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(g._post(body).get("steps", {}))
    raw = (texts[-1] if texts else "").strip().removeprefix("```json").removesuffix("```").strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"age_range": "?", "gender": "?", "description": raw[:80]}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("script")
    ap.add_argument("voices", help="comma-separated voice names")
    ap.add_argument("--line")
    ap.add_argument("--style", help="acting direction to try instead of the script's")
    ap.add_argument("--out")
    ap.add_argument("--times", type=int, default=3, help="judge each sample this many times and average (single guesses vary)")
    args = ap.parse_args()

    script = json.load(open(args.script, encoding="utf-8"))
    line = args.line or script["scenes"][0]["line"]
    style = args.style or script.get("style")
    out = args.out or tempfile.mkdtemp(prefix="voices-")
    os.makedirs(out, exist_ok=True)
    print(f"Samples in {out}\n")
    print(f"{'voice':14} {'length':>7}  {'sounds':10} description")
    for voice in [v.strip() for v in args.voices.split(",") if v.strip()]:
        wav = os.path.join(out, f"{voice}.wav")
        if not os.path.exists(wav):
            g.generate_speech(line, wav, voice=voice, style=style)
        secs = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav],
                                    capture_output=True, text=True, check=True).stdout)
        heard, d = [], {}
        for _ in range(max(1, args.times)):
            d = describe(wav)
            nums = [int(x) for x in re.findall(r"\d+", str(d.get("age_range", "")))][:2]
            if nums:
                heard.append(sum(nums) / len(nums))
        age = f"~{statistics.mean(heard):.0f}" if heard else "?"
        print(f"{voice:14} {secs:6.1f}s  {age:10} {d.get('gender', '')}, {d.get('description', '')}", flush=True)


if __name__ == "__main__":
    main()
