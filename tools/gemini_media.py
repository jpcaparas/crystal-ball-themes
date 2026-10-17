"""Tiny Gemini API client for the voiced themes: one image or one line of speech per call.

Uses the Interactions endpoint (POST /v1beta/interactions) with:
  - gemini-nano-banana-2.1 for square storybook art
  - gemini-3.8-flash-tts for character voices (WAV, 24 kHz mono)

The key comes from GEMINI_API_KEY, a file named by GEMINI_API_KEY_FILE, or a git-ignored `.env`
file at the repo root, in that order.
Only the standard library is used, so `uv run` needs no extra packages for this file.
"""

import base64
import json
import os
import time
import urllib.error
import urllib.request

API = "https://generativelanguage.googleapis.com/v1beta/interactions"
IMAGE_MODEL = os.environ.get("CRYSTAL_BALL_IMAGE_MODEL", "gemini-nano-banana-2.1")
TTS_MODEL = os.environ.get("CRYSTAL_BALL_TTS_MODEL", "gemini-3.8-flash-tts")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class MissingKey(RuntimeError):
    pass


def api_key():
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        return key
    key_file = os.environ.get("GEMINI_API_KEY_FILE", "").strip()  # e.g. a private, session-only file
    if key_file and os.path.exists(key_file):
        with open(key_file, encoding="utf-8") as fh:
            key = fh.read().strip()
        if key:
            return key
    env = os.path.join(REPO, ".env")
    if os.path.exists(env):
        with open(env, encoding="utf-8") as fh:
            for line in fh:
                name, _, value = line.strip().partition("=")
                if name.strip().removeprefix("export ").strip() == "GEMINI_API_KEY":
                    value = value.strip().strip("'\"")
                    if value:
                        return value
    raise MissingKey(
        "No Gemini API key. Put GEMINI_API_KEY=... in the repo's .env file (it is git-ignored), "
        "or export GEMINI_API_KEY, then run this again."
    )


def has_key():
    try:
        api_key()
        return True
    except MissingKey:
        return False


def _post(body, attempts=4):
    req = urllib.request.Request(
        API,
        data=json.dumps(body).encode(),
        headers={"x-goog-api-key": api_key(), "Content-Type": "application/json"},
        method="POST",
    )
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:  # noqa: S310 (fixed https:// API URL)
                return json.load(resp)
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")[:500]
            if err.code in (429, 500, 502, 503, 504) and attempt < attempts - 1:
                time.sleep(2 ** attempt * 3)
                continue
            raise RuntimeError(f"Gemini API {err.code}: {detail}") from None
        except urllib.error.URLError as err:
            if attempt < attempts - 1:
                time.sleep(2 ** attempt * 3)
                continue
            raise RuntimeError(f"Couldn't reach the Gemini API: {err.reason}") from None


def _last_blob(response, kind):
    """Base64 payload of the last `kind` ("image"/"audio") block in the model output."""
    found = []

    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == kind and isinstance(node.get("data"), str):
                found.append(node["data"])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(response.get("steps", response))
    if not found:
        raise RuntimeError(f"The Gemini response had no {kind}. It said: {json.dumps(response)[:400]}")
    return base64.b64decode(found[-1])


def generate_image(prompt, out_path, refs=()):
    """Make a square image. `refs` are image files to edit or keep a character consistent with."""
    content = [{"type": "text", "text": prompt}]
    for ref in refs:
        with open(ref, "rb") as fh:
            mime = {".png": "image/png", ".webp": "image/webp"}.get(os.path.splitext(ref)[1].lower(), "image/jpeg")
            content.append({"type": "image", "data": base64.b64encode(fh.read()).decode(), "mime_type": mime})
    body = {
        "model": IMAGE_MODEL,
        "input": [{"type": "user_input", "content": content}] if refs else prompt,
        "response_format": {"type": "image", "mime_type": "image/jpeg", "aspect_ratio": "1:1"},
    }
    data = _last_blob(_post(body), "image")
    _write(out_path, data)
    return out_path


def generate_speech(text, out_path, voice="Kore", style=None):
    content = {"type": "text", "text": text}
    if style:
        content["annotations"] = [{"type": "speech_metadata", "style": style}]
    body = {
        "model": TTS_MODEL,
        "input": [{"type": "user_input", "content": [content]}],
        "response_format": {"type": "audio", "mime_type": "audio/wav"},
        "generation_config": {"speech_config": [{"voice": voice}]},
    }
    data = _last_blob(_post(body), "audio")
    _write(out_path, data)
    return out_path


def create_voice(description, display_name, gender="female", language_code="en-US", sample_path=None):
    """Design a custom voice from a description (stored in the Google project that owns the key).
    Returns its id ("voice_..."), usable anywhere a voice name is. Optionally saves the preview audio."""
    body = {"store": True, "voice": {
        "model": TTS_MODEL, "type": "prompted", "display_name": display_name[:60],
        "gender": gender, "language_code": language_code, "prompted": {"input": description},
    }}
    url = API.replace("/interactions", "/voices")
    req = urllib.request.Request(url, data=json.dumps(body).encode(),  # noqa: S310 (fixed https:// API URL)
                                 headers={"x-goog-api-key": api_key(), "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:  # noqa: S310 (fixed https:// API URL)
            out = json.load(resp)
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"Gemini API {err.code}: {err.read().decode(errors='replace')[:500]}") from None
    voice = out.get("voice", out)
    voice_id = voice.get("id") or voice.get("name", "").split("/")[-1]
    if not voice_id:
        raise RuntimeError(f"No voice id in the response: {json.dumps(out)[:300]}")
    sample = out.get("sample_audio") or voice.get("sample_audio")
    if sample_path and sample and sample.get("data"):
        _write(sample_path, base64.b64decode(sample["data"]))
    return voice_id


def _write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.part"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)
