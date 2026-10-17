# A secret or personal file leaked

Use this when a key, token, password, family video or photo, or other personal data was committed,
pushed, pasted into an issue or PR, printed in a CI log, or shown in a screenshot.

Work through the steps in order, and tell the user at each step what you found and what you're
about to do. Every step that changes history or GitHub needs their go-ahead.

## 1. Make the secret useless (first, always)

Deleting a commit doesn't un-publish it: forks, clones, caches and bots may already have it.

- **Gemini key:** the user revokes it in Google AI Studio (API keys → delete), makes a new one and
  puts it in `.env`. Check the project's usage page for anything unexpected.
- **GitHub token:** the user revokes it at github.com → Settings → Developer settings.
- **Personal media or data:** can't be revoked. Remove it quickly, and the user can ask GitHub
  Support to purge cached views.

## 2. Find every copy

```bash
gitleaks git --redact --no-banner .                     # secrets anywhere in history
git log --all --oneline -- 'path/to/file'               # every commit that touched a file
git rev-list --objects --all | grep 'name-of-file'      # every stored version
```

Also check issues, PR descriptions and comments, CI logs (re-run or delete the run) and release
assets.

## 3. Remove it from history

Back up first, and rewrite in a separate clone so the user's working copy is never at risk.

```bash
git clone --mirror . ../crystal-ball-themes-backup.git           # keep until everything is verified
git clone --no-local . /tmp/cbt-rewrite && cd /tmp/cbt-rewrite
uvx git-filter-repo --invert-paths --path path/to/file           # a whole file or folder
uvx git-filter-repo --replace-text <(printf 'THE-SECRET==>REDACTED\n')   # a string inside files
git rev-list --objects --all | grep 'name-of-file' || echo gone  # verify
```

Then, with the user's go-ahead, bring the rewritten branch back into the working copy (`git fetch
/tmp/cbt-rewrite main:rewritten`, `git reset --mixed rewritten` keeps uncommitted work), expire the
reflog and `git gc --prune=now`. If the repository was already pushed, the user force-pushes, and
anyone with a clone has to re-clone.

## 4. Stop it happening again

Add a check for the case that got through: a pattern in `test/repo-safety.test.js`, an ignore rule
in `.gitignore`, or a step in `scripts/prepublish.sh`.
