"""Design a custom voice from a description, for when no prebuilt voice fits a character.

Gemini 3.8 Flash TTS creates the voice in the Google project that owns your key and returns an id
like "voice_abc123". Put that id in a theme script's "voice" field. The id only works with keys from
the same project, so the script also keeps the description: anyone else can run this tool with it
to make their own copy. Saved voice lines in assets/sources/ keep working either way.

Usage:
  python3 tools/design_voice.py "An old woman in her late seventies with a crackly voice..." --name "Old Zara"
  ... --gender female --language en-US --sample /tmp/preview.wav
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gemini_media as g  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("description")
    ap.add_argument("--name", required=True, help="a short display name")
    ap.add_argument("--gender", default="female")
    ap.add_argument("--language", default="en-US")
    ap.add_argument("--sample", help="save the preview audio here")
    args = ap.parse_args()
    voice_id = g.create_voice(args.description, args.name, args.gender, args.language, args.sample)
    print(voice_id)


if __name__ == "__main__":
    main()
