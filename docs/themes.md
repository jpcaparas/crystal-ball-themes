# Making themes

There are two ways to make a theme.

- **In the app** (no code): press **+ New theme** and drag in videos, GIFs or photos. The app
  converts them. This is all most people need.
- **As a built-in theme** (this page): make a theme that ships with the app, from code or from a
  script. Use this for animations, talking characters, or anything you want everyone who uses your
  copy of the app to get.

**On this page:** [The rules every clip follows](#the-rules-every-clip-follows) ·
[Pick a kind](#pick-a-kind) · [Drawn animations](#drawn-animations) · [Voiced scenes](#voiced-scenes) ·
[Talking heads](#talking-heads) · [Voices, sounds and effects](#voices-sounds-and-effects) ·
[The Gemini key](#the-gemini-key) · [Checklist for a new built-in theme](#checklist-for-a-new-built-in-theme) ·
[Content guidelines](#content-guidelines)

## The rules every clip follows

| Rule | Why |
| --- | --- |
| 480 × 480, H.264 Constrained Baseline level 3.0, yuv420p, 30 fps | The exact format of the clips that came on the ball |
| MP3 sound, 128 kb/s, 44.1 kHz stereo, always present (even if silent) | Same reason |
| Important things inside the central circle | The screen is round; the corners are hidden |
| File names start with `01-`, `02-`… | The ball plays files in name order |
| Built-in themes live in `assets/themes/<id>/` with a `theme.json` | That's where the app looks |

All the tools below follow these rules for you. `npm run test:tools` checks they still do.

## Pick a kind

```mermaid
flowchart TD
    start(["I want a new built-in theme"]) --> q1{"Do the characters talk?"}
    q1 -- "No" --> drawn["Drawn animation<br/>tools/make_halloween.py"]
    q1 -- "Yes" --> q2{"Should a face move its lips?"}
    q2 -- "No: pictures with motion" --> voiced["Voiced scenes<br/>tools/voice_theme.py"]
    q2 -- "Yes" --> head["Talking head<br/>tools/spirit_theme.py"]
```

| Kind | Looks like | Needs an API key? | Example |
| --- | --- | --- | --- |
| Drawn animation | Shapes drawn frame by frame in Python | No | Halloween |
| Voiced scenes | A painted picture with slow zoom, effects, a caption and a voice | Only to make its pictures and voices with Gemini; any other model works too ([media.md](media.md)) | Monster Parade, Fortune Teller |
| Talking head | Faces that blink and move their mouths in time with a voice; one or a whole cast | Same as voiced scenes | Spirit in the Ball, Midnight Séance, Hollow Hill Parade |

## Drawn animations

`tools/make_halloween.py` draws every frame with [Pillow](https://pillow.readthedocs.io), makes its
own sound effects with numpy, and pipes everything to ffmpeg. It draws at twice the size and shrinks
for smooth edges.

To add a clip to Halloween:

1. Write a function like `clip_pumpkin(path)`. Inside it, define `render(t)` that returns a frame for
   time `t` (use the helpers: `radial_bg`, `glow_layer`, `draw_stars`, `text_layer`, `fit_font`,
   `finish`), build the sound with `tone`, `wind` and `place`, then call
   `encode(path, seconds, render, audio)`.
2. Add it to `CLIPS` with a file name and title.
3. Run `npm run themes:halloween`.

For a new drawn theme, copy the file and change the output folder in its npm script.

## Voiced scenes

`tools/voice_theme.py` turns a script into clips. For each scene it shows one or two pictures with
a slow push-in, adds effects and a caption, makes a glow pulse with the voice, mixes in spooky
background sound, and encodes the result.

```mermaid
flowchart LR
    script["tools/scripts/my-theme.json"] --> art["Picture: Gemini or any model<br/>(only if missing)"]
    script --> voice["Voice: Gemini or any model<br/>(only if missing)"]
    art --> sources[("assets/sources/my-theme/")]
    voice --> sources
    sources --> render["voice_theme.py renders"]
    render --> clips["assets/themes/my-theme/*.mp4"]
```

Pictures and voices are saved in `assets/sources/<id>/`, which git ignores: the script is the
source, and each copy of the project makes its own media, with the built-in Gemini tools or any
other model ([media.md](media.md)). Once they exist, rendering never calls an API again, so you can
re-render for free and offline. Pictures can be `.jpg`, `.png` or `.webp`; voices `.flac`, `.wav`,
`.mp3`, `.m4a` or `.ogg`.

### Script format

```json
{
  "id": "my-theme",
  "name": "My Theme",
  "emoji": "🧛",
  "note": "One line shown under the theme name.",
  "art_style": "Added to the start of every picture prompt, so all pictures match.",
  "ambience": "night",
  "voice": "Charon",
  "style": "Default acting direction for every line.",
  "art": { "shared-picture": "A picture used by several scenes." },
  "scenes": [
    {
      "file": "01-hello",
      "title": "Hello!",
      "line": "Good evening... <short pause> welcome!",
      "art": "A picture just for this scene.",
      "voice": "Algenib",
      "style": "Acting direction for this line only.",
      "fx": ["bats", "fog"]
    },
    {
      "file": "02-reveal",
      "title": "A vision",
      "line": "I see... <long pause> something wonderful!",
      "shots": ["shared-picture", "another-key-in-art"]
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Folder name: lowercase letters, numbers and dashes |
| `name`, `emoji`, `note` | Yes | What the app shows |
| `art_style` | Yes | Shared art direction. Ask for full-bleed pictures with no frame or border, and say the subject should sit in the central circle. |
| `ambience` | No | `night` (wind and a low drone) or `mystic` (a soft shimmering pad and chimes) |
| `voice`, `style` | No | Defaults for every scene |
| `art` | No | Named pictures that scenes can share |
| `scenes[].file` | Yes | Output file name without `.mp4`; sets the play order |
| `scenes[].title` | Yes | Caption on screen and title in the app |
| `scenes[].line` | Yes | Exactly what's said. Put sounds like `<laugh>` inline. |
| `scenes[].art` | One of these two | A picture just for this scene |
| `scenes[].shots` | | Two keys from `art`: the first shows, then dissolves into the second partway through the line |
| `scenes[].voice`, `style` | No | Override the defaults |
| `scenes[].fx` | No | Effects; see below |

### Make it

1. Write the script in `tools/scripts/`.
2. Try it with placeholders first (no API, no cost, any machine with macOS):
   ```bash
   uv run --with-requirements tools/requirements.txt python tools/voice_theme.py tools/scripts/my-theme.json --draft --out /tmp/my-theme
   ```
3. Make it for real (needs [the Gemini key](#the-gemini-key)):
   ```bash
   uv run --with-requirements tools/requirements.txt python tools/voice_theme.py tools/scripts/my-theme.json
   ```
4. Add an npm script for it next to `themes:monsters` in `package.json`, and add it to `themes`
   as `npm run themes:my-theme -- --skip-missing`.

Useful options:

| Option | Does |
| --- | --- |
| `--only <text>` | Render only scenes whose file name contains the text |
| `--jobs <n>` | Render n scenes at once (each uses about one CPU core) |
| `--skip-missing` | If pictures or voices are missing and there's no key, say so and exit cleanly (used by `npm run themes`) |
| `--draft --out <folder>` | Placeholder pictures and the macOS voice, never calls an API |

To redo one picture or one line, delete that file in `assets/sources/<id>/art/` or `voice/` and run
the command again. Only missing files are generated.

## Talking heads

`tools/spirit_theme.py` makes a face that floats inside the ball, blinks, and moves its mouth in
time with the voice.

How it works:

1. Gemini paints the head on a black background, using a reference picture so the character stays
   recognisable.
2. Gemini then edits that picture three times: mouth half open, mouth open, eyes closed.
3. The tool lines the edits up with the original, finds the mouth and eyes by comparing them, and
   blends only those regions in time with how loud the voice is.
4. The head is blended over swirling mist (black becomes see-through), floats gently, and fades in
   and out. The voice gets a soft echo.

Run with `--debug` to save `masks.png` showing the mouth (red) and eye (blue) regions it found. If
the regions look wrong, delete the variant pictures and generate them again.

### Script format

```json
{
  "id": "spirit-in-the-ball",
  "name": "Spirit in the Ball",
  "emoji": "🕯️",
  "note": "One line shown under the theme name.",
  "reference": "fortune-teller/art/zara.jpg",
  "head": "Prompt for the head: front-facing, eyes open, lips closed, pure black background...",
  "variants": {
    "mouth-mid": "Edit: keep everything the same except lips slightly parted.",
    "mouth-open": "Edit: keep everything the same except mouth open in an 'oh'.",
    "blink": "Edit: keep everything the same except eyes closed."
  },
  "voice": "Sulafat",
  "style": "Acting direction for every line.",
  "scenes": [{ "file": "01-awaken", "title": "The spirit awakens", "line": "Ooooh... who knocks?" }]
}
```

`reference` is a picture under `assets/sources/` (optional, but it keeps a character consistent).
The variants must keep the head in exactly the same place; the prompts above say so.

### A cast of characters

A talking-head script can have many characters instead of one head. Add a `characters` block and
give each scene a `character`. Each character gets its own pictures (in `art/<key>/`), voice and acting.

```json
"art_style": "Shared art direction added before every character's head prompt.",
"variants": { "mouth-mid": "...", "mouth-open": "...", "blink": "..." },
"characters": {
  "moon": { "head": "Old Man Moon: a big round full moon with a kind sleepy face...", "voice": "Algenib",
            "style": "a sleepy, kindly old man", "boxes": { "mouth": [0.3, 0.5, 0.7, 0.85] } }
},
"scenes": [{ "file": "01-shine-on", "title": "Old Man Moon", "character": "moon", "line": "Ho-hum..." }]
```

- `variants` can be set once for everyone, or per character.
- `boxes` (optional) tells the tool where to look for the mouth and eyes, as fractions of the
  picture `[left, top, right, bottom]`, for faces that aren't in the usual place.
- A character can also have its own `look` and `reference` picture.
- Use `"caption": true` in `look` to show each scene's `title` (the speaker's name).
- `--prepare` makes all missing pictures and voices without rendering, so you can then render scenes
  in parallel with `--only`. With `--debug` it also saves `masks-<character>.png` to check lip-sync regions.

Hollow Hill Parade (`tools/scripts/hollow-hill-parade.json`) is a full example.

### Look options

Add a `look` block to change how the head is shown. Without it, the head floats on black over
generated mist (Spirit in the Ball).

```json
"look": { "background": "baked", "sway": 8, "mist": 0.3, "glass": 0.12, "grade": "spectral-green",
          "light": [0.55, 1.0, 0.7], "bloom": [0.35, 1.0, 0.6], "scale": 1.06 }
```

| Option | Meaning |
| --- | --- |
| `background` | `"baked"`: the picture brings its own background (ask for one in the `head` prompt) and fills the ball |
| `sway` | How far hair and mist drift, in pixels (try 6 to 10). The face never moves, so lip-sync stays clean. |
| `mist` | How strongly extra moving mist is layered on top (0 to 1) |
| `glass` | A crystal-ball bulge that magnifies the middle (try 0.08 to 0.15) |
| `grade` | A colour effect over the finished picture: `"moody"` (midnight blue, softer colour, amber light) or `"spectral-green"` (a ghostly green wash). Both add a low drone to the sound. |
| `light` | Colour of the soft light under her face, which brightens as she speaks, as `[red, green, blue]` from 0 to 1 |
| `bloom` | Colour of a glow around the brightest parts, which also brightens as she speaks |
| `scale` | Zoom on the picture (1.06 leaves room for the gentle float) |

Keep the picture itself in natural colours and let `grade` add the tint; it looks more ghostly and
the lip-sync edits stay consistent.

Midnight Séance (`tools/scripts/midnight-seance.json`) uses all of them.

Commands are the same as for voiced scenes, using `tools/spirit_theme.py`.

## Voices, sounds and effects

**Voices** (Gemini's prebuilt voices; pick by feel):

| Voice | Feel | Voice | Feel | Voice | Feel |
| --- | --- | --- | --- | --- | --- |
| Zephyr | Bright | Puck | Upbeat | Charon | Informative, deep |
| Kore | Firm | Fenrir | Excitable | Leda | Youthful |
| Orus | Firm | Aoede | Breezy | Callirrhoe | Easy-going |
| Autonoe | Bright | Enceladus | Breathy | Iapetus | Clear |
| Umbriel | Easy-going | Algieba | Smooth | Despina | Smooth |
| Erinome | Clear | Algenib | Gravelly | Rasalgethi | Informative |
| Laomedeia | Upbeat | Achernar | Soft | Alnilam | Firm |
| Schedar | Even | Gacrux | Mature | Pulcherrima | Forward |
| Achird | Friendly | Zubenelgenubi | Casual | Vindemiatrix | Gentle |
| Sadachbia | Lively | Sadaltager | Knowledgeable | Sulafat | Warm |

**Pick a voice by ear, not by name.** Many voices sound younger than you'd expect, and the acting
direction matters as much as the voice. For an old fortune teller, Gacrux with the direction
"a very old woman in her seventies, her voice crackly, raspy and thin with age…" sounded 65 to 70;
the same voice with a plainer direction sounded about 35. Whispered lines always sound younger.

Audition a few voices before generating every line (needs the key):

```bash
python3 tools/audition_voices.py tools/scripts/my-theme.json Gacrux,Vindemiatrix,Sulafat --style "a very old woman..."
```

It says the first line (or `--line`) in each voice, saves the samples, and asks a Gemini audio model
how old each speaker sounds, averaging three listens because single guesses vary.

**No prebuilt voice fits?** Design one from a description:

```bash
python3 tools/design_voice.py "An elderly storyteller with a dry, crackly voice..." --name "My character" --sample /tmp/preview.wav
```

It prints an id like `voice_abc123`; use it as the `voice` in a script and audition it like any
other. Designed voices belong to the Google project that made them, so write the description in the
script's `note` too; anyone forking can design their own from it. Saved lines keep working either way.

**Acting** goes in `style` ("deep and theatrical, playful rather than scary"). **Sounds** go inline
in the line, in angle brackets, where they should happen:

`<laugh>` `<chuckle>` `<giggle>` `<cackle>` `<snicker>` `<growl>` `<groan>` `<hiss>` `<gasp>`
`<sigh>` `<yawn>` `<breath>` `<whispers>` `<scream>` `<shriek>` `<cough>` `<sneeze>` `<snort>`
`<short pause>` `<long pause>`

**Effects** for voiced scenes (`fx`):

| Effect | Looks like |
| --- | --- |
| `bats` | Small bats flapping across the top |
| `fog` | Drifting fog, thickest at the bottom |
| `embers` | Orange sparks rising |
| `dust` | Floating dust motes |
| `sparkles` | Twinkling stars |
| `moon-glow` | A soft glow pulsing at the top right |
| `lightning` | Two quick flashes |

## The Gemini key

Only needed to make pictures or voices with the built-in Gemini tools. Rendering from saved files
never needs it, and any other model can make the media instead ([media.md](media.md)).

1. Get a key at [Google AI Studio](https://aistudio.google.com/apikey).
2. Copy `.env.example` to `.env` in the repo folder and fill it in:
   ```
   GEMINI_API_KEY=your-key-here
   ```
   `.env` is git-ignored, so it won't be committed. Never paste the key anywhere else. You can also set `GEMINI_API_KEY` in your shell,
   or point `GEMINI_API_KEY_FILE` at a private file that holds only the key.
3. `npm run doctor` shows whether a key is set (it never prints it).

Models are `gemini-nano-banana-2.1` for pictures and `gemini-3.8-flash-tts` for voices. To use
others, set `CRYSTAL_BALL_IMAGE_MODEL` or `CRYSTAL_BALL_TTS_MODEL`.

## Checklist for a new built-in theme

- [ ] Script in `tools/scripts/` (or a function in a drawing tool)
- [ ] Tried with `--draft` first
- [ ] Media made locally for voiced and talking-head themes (`npm run media:plan` shows ✓). It isn't committed
- [ ] `assets/themes/<id>/theme.json` committed (the render writes it)
- [ ] npm script added, and included in `npm run themes` with `-- --skip-missing`
- [ ] `npm run test:tools` and `npm test` pass
- [ ] Looked at it with **▶ Preview** in the app
- [ ] Added to the themes table in the README

## Content guidelines

- **It plays to children at the front door.** Spooky-funny, never gory or mean.
- **Keep lines short.** 5 to 15 seconds each is about right.
- **No copyrighted characters.** Use original characters, or ones from public-domain stories, and
  avoid copying a particular film's look. A theme for a franchise can ship empty, for clips the
  family owns.
- **Say where generated content came from** in the README's credits.
