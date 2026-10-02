# beliq-eu shared configuration

Org-wide Renovate presets, and the guard workflow every repo's CI calls. Repos reference
these instead of duplicating the full policy.

## Presets

- `default.json` (`local>beliq-eu/.github`) — base policy: weekly schedule, dependency
  dashboard, semantic commits, grouped patch and minor updates, one PR per major (the one
  exception being the vitest family, whose packages peer-pin each other and so share a
  branch), security alerts labelled and assigned, a three-day minimum release age for npm
  and PyPI updates (see "Minimum release age" below), plus the custom manager described
  under "Version pins no built-in manager reads" below. No auto-merge.
- `automerge.json` (`local>beliq-eu/.github:automerge`) — extends the base and adds
  auto-merge for patch and digest updates (and security updates) once CI passes. Only use
  this in repos that run a check on `pull_request`, otherwise updates merge with no gate.
  Minor updates are not auto-merged by this preset (see "Auto-merging minor updates" below).
  It also sets `rebaseWhen: "conflicted"`. Renovate's default, `auto`, turns into
  `behind-base-branch` as soon as auto-merge is on, so every open update PR is rebased, and
  its whole CI re-run, each time `main` moves. Between 2026-09-19 and 2026-09-23 one patch-update
  PR in a consuming repo ran its CI 16 times and two further checks 18 and 17 times,
  all billed Actions minutes. `conflicted` is safe
  here because no consuming repo requires branches to be up to date before merging (none
  has `strict_required_status_checks_policy: true`, checked
  2026-09-24), and each repo's `main` CI tests the merged tree anyway. A repo that turns
  strict on needs `"rebaseWhen": "auto"` in its own `renovate.json`, or its auto-merge
  stalls on the first out-of-date PR.

## Usage

Repo without a PR-triggered CI check:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["local>beliq-eu/.github"]
}
```

Repo with a PR-triggered CI check:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["local>beliq-eu/.github:automerge"]
}
```

### Auto-merging minor updates

A repo that also wants minor updates merged on green adds the rule to its own
`renovate.json`:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["local>beliq-eu/.github:automerge"],
  "packageRules": [{ "matchUpdateTypes": ["minor"], "automerge": true }]
}
```

Add it only where the default branch carries a required status check set with a non-empty
context list, so that `green` means a named check ran and passed, not that nothing ran.
`GET /repos/{owner}/{repo}/rules/branches/{branch}` answers it. A repo with no ruleset reports
`mergeable_state: clean` with nothing enforcing it, which an auto-merge rule must never read
as a pass. On 2026-09-22 no beliq-eu repo had such a ruleset, so none of them carries the rule.

### Consumers in another org

`local>` resolves against the platform, not the org, so both forms above reach this repo
from anywhere on github.com. `github>beliq-eu/.github:automerge` is the same preset under
another spelling. The two are interchangeable, so a repo already wired one way
stays that way: the only thing worth checking in a new repo is that it extends this preset
at all.

## Minimum release age

`default.json` extends Renovate's `security:minimumReleaseAgeNpm` and
`security:minimumReleaseAgePypi`. Renovate offers no npm or PyPI version until it has been
on the registry for three days. Both presets also set `internalChecksFilter: "strict"`, so
no branch exists before then either: Renovate proposes the newest version that is old
enough, and the Dependency Dashboard lists the younger ones as pending.

Why this preset needs it: through `automerge.json` it merges patch and digest updates on
green CI, and minor updates in the repos that add that rule, with nobody looking. Before anything
merges, the Renovate branch's own CI installs the new version with whatever that workflow
can reach. Where a Renovate branch needs its lockfile repaired by hand, the new version is
installed on a laptop too. The 2025 npm compromises (the chalk and
debug hijack in September, then the Shai-Hulud worm waves) were pulled within hours to
about a day, so three days outlasts them.

Not covered, by design or by limit:

- **Security updates bypass the delay**, by Renovate's design, so a vulnerability fix is
  never held back.
- **`lockFileMaintenance`, `pin`, `replacement`, `bump`, `rollback` and `lockfileUpdate`
  updates get no age check.** Renovate cannot age them, so the presets exempt them and add a
  warning to the PR body.
- **GitHub Actions are not covered.** The presets match only the npm and PyPI datasources,
  and a force-pushed existing tag would pass an age check anyway, because `github-tags`
  ages a digest against the matched version's release timestamp.
- **A dependency added by hand** (`yarn add`, `npm install <pkg>`) is not a Renovate update
  and is not delayed.

Renovate itself recommends 14 days wherever third-party dependencies auto-merge. Three days
is the presets' own value, chosen 2026-09-27 because security fixes bypass the delay
either way. Sources:
[minimum release age](https://docs.renovatebot.com/key-concepts/minimum-release-age/),
[security presets](https://docs.renovatebot.com/presets-security/),
[upgrade best practices](https://docs.renovatebot.com/upgrade-best-practices/).

## Version pins no built-in manager reads

Renovate reads a version only where one of its managers looks. A version typed into a
`run:` line is invisible to all of them, so a pin added there freezes on the day it was
typed, and pinning without a manager trades a moving-target risk for a stale-CVE one.

Seven release workflows pin npm itself so a publish cannot silently move to a newly
released npm:

```yaml
      - name: Upgrade npm
        # renovate: datasource=npm depName=npm
        run: npm install -g npm@12.0.2
```

The marker comment is what `default.json`'s `customManagers` entry matches. It has to sit
directly above the line holding the version, because the regex reads the first
`<major>.<minor>.<patch>` on the next line: one line higher and it would read whatever
version that line happens to carry, or nothing at all.

Two things this is deliberately not:

- Not the built-in `customManagers:githubActionsVersions` preset, which only reads
  `<NAME>_VERSION:` environment variables and so does not cover a `run:` line.
- Not needed for `astral-sh/setup-uv`'s `version:` input. Renovate's `github-actions`
  manager already extracts that as a `uses-with` dependency. Verified 2026-09-22 against
  `beliq-sdk-python`: lowering all three sites to `0.12.10` made Renovate propose
  `0.12.17` with no marker comment and no custom manager. A marker there would be read
  twice and reported as a duplicate.

The file scope is `ci.yml` and `release.yml` rather than every workflow, so the manager
does not also claim `beliq-validate-action/.github/workflows/test-action.yml`, whose pin
that repo's own `renovate.json` manager owns. A preset's `customManagers` and a repo's are
appended, not replaced, so an overlapping file pattern reads the same line through both.

### Checking it

`renovate-config-validator` proves `default.json` is well formed. It never opens a
consuming repo, so it cannot tell a working manager from one whose file pattern matches
nothing, which is exactly how the npm pin sat unread from 2026-09-19 to 2026-09-22. CI runs
both:

```bash
npx --yes --package renovate renovate-config-validator --strict default.json automerge.json
node scripts/check-custom-managers.mjs ../activepieces-beliq ../beliq-cli ...
```

The script takes repo checkouts and fails when a workflow carries a marker comment no
manager claims or can read, when an `npm install -g npm@` line carries no marker, when a
marker sits on an input the `github-actions` manager already reads, or when the run finds
nothing at all to check. `.github/workflows/ci.yml` clones every `beliq-eu` repo and passes
them in, so a marker deleted in any of them reds this repo.

## GitHub Actions policy

Two rules. They apply to `.github/workflows/**` **and** to any `action.yml` this org
publishes, because a `uses:` inside a published composite action runs in the caller's CI,
not ours.

### 1. Pin to a full commit SHA, keep the tag as a trailing comment

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
```

A tag is mutable: whoever can move `v4` can run their code inside a workflow holding GHCR
push credentials, sibling PATs and deploy access. `default.json` sets `pinDigests` for the
`github-actions` manager so Renovate pins anything new and keeps the digests current.
Scoped to that manager on purpose — a repo-wide `pinDigests` would also freeze the Docker
`:latest` reference that a deploy script moves by hand.

### 2. Track the latest major, and never sit on a retired Node runtime

Every JavaScript action declares a `runs.using` runtime, and GitHub retires those on a
schedule: **Node 20 is removed from the runners on 2026-09-23**, and the
`ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true` opt-out is removed with it
([changelog](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/)).
A pinned SHA is not protection here: it pins the *code*, and the runtime that code asks for
is what disappears.

So the convention is the latest major of every `actions/*` action, which is also the way to
stay on a current runtime without tracking runtime deprecations per action. Baseline as of
2026-08-31, all `node24`:

| action | major | SHA |
| --- | --- | --- |
| `actions/checkout` | v7 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | v7 | `820762786026740c76f36085b0efc47a31fe5020` |
| `actions/setup-python` | v7 | `5fda3b95a4ea91299a34e894583c3862153e4b97` |
| `actions/upload-artifact` | v7 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| `actions/cache` | v6 | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` |

Renovate opens one PR per major (`groupName: null` for majors, deliberately), so majors
arrive as separate PRs and **need merging by hand**. They are the ones that carry the
runtime bump, so an unmerged stack of them is the failure mode this rule exists to catch:
the org sat on `actions/checkout` v7 PRs from 2026-08-17 while the estate stayed on node20.

Node 24 releases of these actions require self-hosted runners at **v2.327.1 or newer**.
Every beliq-eu job runs on `ubuntu-latest`, so this only constrains self-hosted runners
in consuming repos outside this org.

### Checking the estate

```bash
# every uses: in the org, with the runtime the pinned SHA actually declares
gh api /repos/beliq-eu/<repo>/contents/<path> -H 'Accept: application/vnd.github.raw' \
  | grep -oE 'uses:[[:space:]]*[^[:space:]]+@[^[:space:]]+'
gh api /repos/<action>/contents/action.yml?ref=<sha> -H 'Accept: application/vnd.github.raw' \
  | sed -n '/^runs:/,/^[a-z]/p'
```

A `uses:` with no 40-character SHA fails rule 1. A `runs.using` of `node20` fails rule 2.

## Guard

`.github/workflows/guard.yml` is a reusable workflow that every repo calls from its own CI,
so a pull request fails before it merges:

```yaml
  guard:
    uses: beliq-eu/.github/.github/workflows/guard.yml@<commit> # main
```

Pin it to a commit, as rule 1 above asks of every `uses:`. Each job checks this repo out at
`job.workflow_sha`, the commit the caller pinned, and runs the scripts and config found
there, so a repo's checks stay fixed until a Renovate digest PR moves the pin. Renovate
reads the `# main` comment as the branch the digest follows, and `automerge.json` merges the
digest PR once CI passes, so a change here reaches every repo within one Renovate run.

Three jobs:

- `content`: the public scrub and the hidden-character check, both below.
- `workflows`: zizmor at `high` and actionlint over the repo's `.github`. zizmor gets the
  job's token, so its online audits run too, among them the check that a pinned commit
  belongs to the action's own repository. The `medium` findings are `artipacked`, a checkout
  that keeps its token, and some workflows push with exactly that token, so each needs its
  own decision before the floor can drop. actionlint runs the shellcheck the runner image
  ships on every `run:` script.
- `secrets`: gitleaks over every commit reachable from the one under test, with `--redact`,
  because a public repo's CI log is public. A repo's own `.gitleaks.toml` and
  `.gitleaksignore` apply.

zizmor is pinned with every hash in `.github/guard-requirements.txt`; Renovate's
`pip_requirements` manager moves the version and rewrites the hashes with hashin. actionlint
and gitleaks are release downloads checked against upstream's own checksum files. Nothing
bumps those two, so a bump is a hand edit that moves the version and the hash together.
`.github/actionlint.yaml` ignores actionlint's errors on the `job.workflow_*` properties in
`guard.yml` until https://github.com/rhysd/actionlint/pull/707 ships in a release.

### A change here, and the repos that pin it

A repo compares its `AGENTS.md` and `CLAUDE.md` with the copies at the commit it pins, and
checks its links against that commit's `publicOwners`. So a change to either file, or a new
public owner, reaches a repo through one pull request there that takes the new copy or link
and moves the guard pin to the commit that made the change. Until then the repo stays green
on its old pin, and the `content` job in this repo's CI, which checks every repo against
the current commit, names it. A Renovate digest PR that arrives first fails on the old copy,
and Renovate closes it once the pin has moved past it.

### Public scrub

Every repo this account owns is public, so planning notes, runbooks, local paths and links
to private repos must stay out of them. `scripts/check-public-scrub.mjs` fails a repo that
tracks:

- a file whose name contains `roadmap` in any case, or starts with `PASS-`, `SUBMISSION` or
  `PR-COMMENT`;
- a line that links to a roadmap Markdown file, names a `<word>-hq` store, or holds a local
  home or workspace path;
- a GitHub link or an `owner/repo#N` reference whose owner is not in `publicOwners` in
  `public-scrub.json`. Lockfiles are exempt from this rule only, because they list every
  dependency's publisher;
- an `AGENTS.md` or `CLAUDE.md` that differs from the copy in this repo.

`vendor/` and `node_modules/` are skipped. The patterns are generic and the output names
only the file, line and rule, never the matched text: a public repo's CI log is public too,
so the check must not publish what it guards.

A new link to a public account that fails the check goes into `publicOwners`, and the repo
that needs it moves its guard pin to that commit. Locally:
`node scripts/check-public-scrub.mjs ../<repo> ...` and
`node --test scripts/check-public-scrub.test.mjs`.

### Hidden characters

`scripts/check-hidden-text.mjs` fails a repo that tracks a text file holding a bidirectional
control or mark (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), a zero-width
character (U+200B to U+200D, U+2060, and U+FEFF anywhere but the very start of a file), or a
Unicode tag character (U+E0000 to U+E007F). A bidi override shows a reviewer code in a
different order than the compiler reads it (CVE-2021-42574), and tag characters spell out
text that an agent reads and a reviewer cannot see.

A file that has to hold one, an official fixture for instance, goes into the repo's
`.github/hidden-text-allow.txt`, one path per line, `#` for comments. An entry whose file no
longer holds such a character fails too, so the list only shrinks. Skips and output follow
the scrub: no `vendor/` or `node_modules/`, and no line text in the log. Locally:
`node scripts/check-hidden-text.mjs ../<repo> ...` and
`node --test scripts/check-hidden-text.test.mjs`.

### Where the content checks run

- In each repo's own CI, through the `content` job of `guard.yml`.
- In `.github/workflows/ci.yml`, job `content`, over this repo and a fresh clone of every
  non-fork repo of the account, on each push and pull request here and daily at 04:23 UTC.
