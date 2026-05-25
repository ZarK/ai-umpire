# Release Controls

This file records the expected public-release controls for `@tjalve/aiu`.

## GitHub Repository

- Visibility: private until CI, branch protection, and publish workflow changes are merged.
- Default branch: `main`.
- Required branch protection for `main`:
  - require signed commits
  - require a pull request before merging
  - require at least one approving review
  - require CODEOWNERS review
  - dismiss stale approvals after new pushes
  - require approval for the most recent push
  - require conversation resolution
  - require the `release-check` CI status and up-to-date branches
  - require linear history
  - disable force pushes
  - disable branch deletion
- Workflow permissions default to read-only.

## GitHub Actions

- CI workflow: `.github/workflows/ci.yml`.
- Publish workflow: `.github/workflows/publish.yml`.
- Third-party actions are pinned to full commit SHAs.
- CI installs with `pnpm install --frozen-lockfile --ignore-scripts`.
- Publish uses the protected `npm-publish` environment, `id-token: write`, and `npm publish` for npm Trusted Publishing provenance.

## npm Publishing

- Primary publish path: npm trusted publishing for `ZarK/ai-umpire`, workflow file `publish.yml`, environment `npm-publish`.
- Long-lived `NPM_TOKEN` secrets are not required for the primary publish path.
- The `npm-publish` GitHub environment must require reviewer approval before a tag publish can proceed.

## Current External Blockers

- GitHub rejected required reviewers on `npm-publish` while the repository is private. Enable after public visibility or on a plan that supports private environment reviewers.
- GitHub rejected secret scanning and push protection while the repository is private. Enable after public visibility or on a plan that supports those features for private repositories.
- npm trusted publishing must be configured in npm for `@tjalve/aiu`; this is an npm account/scope setting and cannot be verified from repository files alone.
- GitHub must recognize the maintainer signing key before the signed-commit acceptance criterion can be closed.
