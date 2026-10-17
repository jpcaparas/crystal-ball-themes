#!/usr/bin/env bash
# Builds the ffmpeg and ffprobe that ship inside the packaged app, for this Mac's architecture, from
# pinned upstream sources whose checksums are verified. They're static: they use only libraries
# every Mac already has, so the app can add clips and make play-all videos without Homebrew.
#
# Output (git-ignored):
#   vendor/darwin-<arch>/ffmpeg/   ffmpeg, ffprobe, LICENSE.txt (GPL v2), SOURCES.txt
#   vendor/ffmpeg-sources.tar      the exact sources used, published with each release (GPL)
#
# Usage: bash tools/build_ffmpeg.sh
# Needs: Xcode command line tools, pkg-config, git; nasm on Intel Macs (brew install pkgconf nasm).
set -euo pipefail

# Upstream sources. Checksums were cross-checked against Homebrew's formulae.
FFMPEG_VERSION=9.0.2
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
LAME_VERSION=4.0
LAME_URL="https://deb.debian.org/debian/pool/main/l/lame/lame_${LAME_VERSION}.orig.tar.gz" # identical to SourceForge's, which blocks scripts
LAME_SHA256=3df5124d5ad3a98312ffd7ba6a9b36230e4f8a3e66d3ce0f425e336c32d216eb
X264_REPO=https://code.videolan.org/videolan/x264.git
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55 # the "stable" branch (r3222)

ROOT=$(cd "$(dirname "$0")/.." && pwd)
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
OUT="$ROOT/vendor/darwin-$ARCH/ffmpeg"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
PREFIX="$WORK/prefix"
SRC="$WORK/sources"
JOBS=$(sysctl -n hw.ncpu)
mkdir -p "$PREFIX" "$SRC"

export MACOSX_DEPLOYMENT_TARGET=12.0 # the oldest macOS Electron supports
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" # never pick up Homebrew's libraries by accident

step() { printf '\n== %s\n' "$1"; }
fetch() { # url file sha256
  curl -fsSL --retry 3 -A "crystal-ball-themes-build" -o "$SRC/$2" "$1"
  echo "$3  $SRC/$2" | shasum -a 256 --check --status || { echo "Checksum mismatch for $2" >&2; exit 1; }
  echo "  $2: checksum ok"
}

step "Downloading and verifying sources"
fetch "$FFMPEG_URL" "ffmpeg-${FFMPEG_VERSION}.tar.xz" "$FFMPEG_SHA256"
fetch "$LAME_URL" "lame-${LAME_VERSION}.tar.gz" "$LAME_SHA256"
git clone --quiet "$X264_REPO" "$WORK/x264"
git -C "$WORK/x264" -c advice.detachedHead=false checkout --quiet "$X264_COMMIT"
[ "$(git -C "$WORK/x264" rev-parse HEAD)" = "$X264_COMMIT" ] || { echo "x264 commit mismatch" >&2; exit 1; }
git -C "$WORK/x264" archive --format=tar.gz --prefix="x264-${X264_COMMIT}/" -o "$SRC/x264-${X264_COMMIT}.tar.gz" HEAD
echo "  x264 at $X264_COMMIT"

step "Building LAME (MP3 encoder)"
tar -xzf "$SRC/lame-${LAME_VERSION}.tar.gz" -C "$WORK"
(
  cd "$WORK/lame-${LAME_VERSION}"
  ./configure --quiet --prefix="$PREFIX" --enable-static --disable-shared --disable-frontend --disable-decoder \
    --disable-gtktest --disable-dependency-tracking
  make --quiet -j"$JOBS" install
)

step "Building x264 (H.264 encoder)"
(
  cd "$WORK/x264"
  ./configure --prefix="$PREFIX" --enable-static --enable-pic --disable-cli --disable-opencl \
    --disable-lavf --disable-swscale --disable-ffms --disable-gpac --disable-lsmash >/dev/null
  make -j"$JOBS" install >/dev/null
)

step "Building FFmpeg ${FFMPEG_VERSION}"
tar -xJf "$SRC/ffmpeg-${FFMPEG_VERSION}.tar.xz" -C "$WORK"
CONFIGURE_FLAGS=(
  --prefix="$PREFIX"
  --enable-gpl --enable-libx264 --enable-libmp3lame
  --disable-autodetect --enable-zlib --enable-bzlib # only libraries macOS ships
  --disable-ffplay --disable-doc --disable-network --disable-debug
  --disable-outdevs --disable-indevs --enable-indev=lavfi # the app makes silent audio tracks with lavfi
  --pkg-config-flags=--static
  --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib"
)
(
  cd "$WORK/ffmpeg-${FFMPEG_VERSION}"
  ./configure "${CONFIGURE_FLAGS[@]}" >/dev/null
  make -j"$JOBS" >/dev/null
)

step "Checking and installing into ${OUT#"$ROOT"/}"
rm -rf "$OUT" && mkdir -p "$OUT"
for tool in ffmpeg ffprobe; do
  cp "$WORK/ffmpeg-${FFMPEG_VERSION}/$tool" "$OUT/$tool"
  strip -x "$OUT/$tool"
  codesign --sign - --force "$OUT/$tool" 2>/dev/null # ad-hoc: Apple silicon only runs signed code
  if otool -L "$OUT/$tool" | tail -n +2 | grep -vqE '^\s+(/usr/lib/|/System/Library/)'; then
    echo "$tool links a library macOS doesn't ship:" >&2; otool -L "$OUT/$tool" >&2; exit 1
  fi
done
encoders=$("$OUT/ffmpeg" -hide_banner -encoders)
if ! grep -q libx264 <<<"$encoders" || ! grep -q libmp3lame <<<"$encoders"; then
  echo "ffmpeg is missing libx264 or libmp3lame" >&2; exit 1
fi
"$OUT/ffmpeg" -hide_banner -v error -f lavfi -i anullsrc=r=44100:cl=stereo -t 0.1 -f null - ||
  { echo "ffmpeg can't make the silent audio track the app needs (lavfi)" >&2; exit 1; }
cp "$WORK/ffmpeg-${FFMPEG_VERSION}/COPYING.GPLv2" "$OUT/LICENSE.txt"
cat >"$OUT/SOURCES.txt" <<EOF
ffmpeg and ffprobe in this folder are FFmpeg ${FFMPEG_VERSION} (https://ffmpeg.org) with x264 and LAME,
built for macOS ${MACOSX_DEPLOYMENT_TARGET}+ ($(uname -m)) by tools/build_ffmpeg.sh in
https://github.com/jpcaparas/crystal-ball-themes. Licence: GNU GPL version 2 or later (LICENSE.txt).
Crystal Ball Themes runs them as separate programs; its own code is MIT-licensed.

Sources (also attached to each release as ffmpeg-sources.tar):
  FFmpeg ${FFMPEG_VERSION}  ${FFMPEG_URL}  sha256 ${FFMPEG_SHA256}
  LAME ${LAME_VERSION}      ${LAME_URL}  sha256 ${LAME_SHA256}
  x264          ${X264_REPO} commit ${X264_COMMIT}

FFmpeg configure flags: ${CONFIGURE_FLAGS[*]//$PREFIX/<prefix>}
EOF
cp "$ROOT/tools/build_ffmpeg.sh" "$SRC/"
tar -cf "$ROOT/vendor/ffmpeg-sources.tar" -C "$SRC" .
du -sh "$OUT"/ffmpeg "$OUT"/ffprobe
"$OUT/ffmpeg" -hide_banner -version | head -1
echo "Done."
