# First-time GitHub settings

The user does this once, after creating the repository and before (or right after) making it
public. These are account actions: hand the list to the user rather than running them unasked.

Replace `OWNER/REPO` below, e.g. `jpcaparas/crystal-ball-themes`. Each step can also be done in the
web UI under **Settings**.

## Before the first push

- [ ] Run `bash .agents/skills/public-repo-safety/scripts/prepublish.sh`. It must report nothing.
- [ ] Create the repository **private** first: `gh repo create OWNER/REPO --private --source . --push`.
- [ ] Wait for CI to go green, then make it public: `gh repo edit OWNER/REPO --visibility public --accept-visibility-change-consequences`.

## Security features (Settings → Advanced Security)

```bash
gh api -X PUT repos/OWNER/REPO/private-vulnerability-reporting        # "Report a vulnerability" button
gh api -X PUT repos/OWNER/REPO/vulnerability-alerts                   # Dependabot alerts
gh api -X PUT repos/OWNER/REPO/automated-security-fixes               # Dependabot security updates
gh api -X PATCH repos/OWNER/REPO --input - <<'EOF'
{ "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" } } }
EOF
```

Code scanning uses the CodeQL workflow in `.github/workflows/codeql.yml`. Don't also turn on CodeQL
"default setup", which conflicts with it.

## Actions (Settings → Actions → General)

```bash
gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -F default_workflow_permissions=read -F can_approve_pull_request_reviews=false
gh api -X PUT repos/OWNER/REPO/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors
```

- Workflow permissions: **read repository contents** only, and Actions may not approve pull requests.
- Fork pull requests from outside contributors need approval before their workflows run.

## Protect main (Settings → Rules → Rulesets)

```bash
gh api -X POST repos/OWNER/REPO/rulesets --input - <<'EOF'
{ "name": "main", "target": "branch", "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "Lint, unit tests, audit (Linux)" },
          { "context": "Workflow security (actionlint, zizmor)" },
          { "context": "Secret scan (whole history)" },
          { "context": "Fresh clone on macos-26" } ] } } ] }
EOF
```

This blocks force-pushes and deleting `main`, and changes must pass CI first, so work goes through
pull requests. A solo maintainer can still merge their own pull requests. Leave out the status-check
rule to keep pushing straight to `main`.
