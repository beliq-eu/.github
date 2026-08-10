# beliq-eu shared configuration

Org-wide Renovate presets. Repos reference these instead of duplicating the full policy.

## Presets

- `default.json` (`local>beliq-eu/.github`) — base policy: weekly schedule, dependency
  dashboard, semantic commits, grouped patch and minor updates, one PR per major, security
  alerts labelled and assigned. No auto-merge.
- `automerge.json` (`local>beliq-eu/.github:automerge`) — extends the base and adds
  auto-merge for patch and digest updates (and security updates) once CI passes. Only use
  this in repos that run a check on `pull_request`, otherwise updates merge with no gate.

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
