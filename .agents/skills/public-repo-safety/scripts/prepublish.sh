#!/usr/bin/env bash
# Everything that must be true before this repository, or new commits, go public. Checks the working
# tree and every commit in the history. Read-only: it reports problems and never changes anything.
#
# Usage: bash .agents/skills/public-repo-safety/scripts/prepublish.sh   (or: npm run check:public)
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1
problems=0
section() { printf '\n== %s\n' "$1"; }
bad() { printf '  ✗ %s\n' "$1"; problems=$((problems + 1)); }
ok() { printf '  ✓ %s\n' "$1"; }

section "Working tree: secrets, personal data, media, ignore rules"
if node --test --test-reporter=dot test/repo-safety.test.js >/dev/null 2>&1; then
  ok "test/repo-safety.test.js passes"
else
  bad "test/repo-safety.test.js fails: run it to see why (node --test test/repo-safety.test.js)"
fi

section "History: secrets in any commit"
if command -v gitleaks >/dev/null 2>&1; then
  if gitleaks git --redact --no-banner --exit-code 1 . >/dev/null 2>&1; then
    ok "gitleaks found nothing"
  else
    bad "gitleaks found something: run gitleaks git --redact --no-banner ."
  fi
else
  printf '  – gitleaks is not installed (brew install gitleaks). CI runs it on every push.\n'
fi

section "History: generated media and large files in any commit"
blobs=$(git rev-list --objects --all |
  git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' |
  awk '$1 == "blob" && ($2 > 1000000 || $3 ~ /^assets\/sources\// || tolower($3) ~ /\.(mp4|m4v|mov|webm|mkv|avi|flac|wav|mp3|m4a|ogg|aiff?)$/) { print "    " $2 " bytes  " $3 }' |
  sort -u)
if [ -n "$blobs" ]; then
  bad "media or large files are stored in history (rewrite it: references/leaked-secret.md)"
  printf '%s\n' "$blobs" | head -20
else
  ok "no media or files over 1 MB in any commit"
fi

section "History: commit messages"
msgs=$(git log --all --format='%h %B' | grep -inE '/(Users|home)/[^/ ]+/|co-authored-by:|generated (with|by) ' || true)
if [ -n "$msgs" ]; then
  bad "commit messages contain home paths or attribution lines"
  printf '    %s\n' "$msgs" | head -20
else
  ok "no home paths or attribution lines in commit messages"
fi

section "History: who the commits say wrote them (published with the repo)"
git log --all --format='%an <%ae>%n%cn <%ce>' | sort -u | sed 's/^/    /'
printf '  Check these are addresses you are happy to publish.\n'

section "Result"
if [ "$problems" -eq 0 ]; then
  ok "ready to publish"
else
  bad "$problems problem(s) to fix before publishing"
  exit 1
fi
