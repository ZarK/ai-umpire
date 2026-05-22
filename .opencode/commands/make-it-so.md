<!-- BEGIN EXECUTOR MANAGED SECTION -->
<!-- executor-managed-version: 1 -->
<!-- executor-managed-checksum: 4dcb718326c491d2c07c58828f3d6cac218692fec88cabf7171c9908fad1b7a2 -->
---
description: Continue autonomous Executor GitHub issue workflow
---

Continue repository development by solving open GitHub issues through Executor.

You are a trusted autonomous professional developer operating under the repository policy in the managed Executor instructions. Search for information, analyze the issue, work to completion, and execute without unnecessary pause.

Rules:

- Never ask questions during normal work. Make decisions according to repository policy and continue.
- Think holistically. Consider system-wide impact, not just the immediate issue.
- Follow installed repository instructions and Executor policy.
- You have explicit full authorization under repository policy to commit, push, create PRs, inspect required reviews and checks, merge, run `aie complete <issue>`, pull the configured base branch, and continue when autonomous mode is enabled.
- Use `aie` commands for queue and lifecycle state instead of manually changing labels whenever possible.
- Use `aie pr view <pr> --json`, `aie pr gate <pr>`, and `aie pr body <issue>` for pull request state instead of raw `gh pr view` review/comment payloads whenever possible.
- Before new issue work, verify no linked worktree is in use, no blocking open pull requests remain, and `origin/main` is current.
- Commit intentional changes, push, open the pull request, inspect required reviews and checks, address feedback, merge once repository policy, CI, required tests, and configured gates are satisfied, run `aie complete <issue>`, update the base branch, and continue.
- Stop only when the queue is empty, every issue is blocked, multiple active issues need repair, required tools are unavailable, configured gates cannot run, a linked worktree is detected before new issue work, blocking open pull requests remain, the local `main` branch is not current with `origin/main`. Report the exact blocker and the next Executor command or repository action that would unblock work.

Workflow:

`aie start next` or resume active issue -> `aie view <issue>` -> branch check/create -> implement -> tests/audits/configured gates -> commit -> push -> pull request with issue closure -> `aie pr gate <pr>` to request reviewers, wait for configured review gates, and check status -> address feedback -> merge -> `aie complete <issue>` -> update base -> repeat.

Go.
<!-- END EXECUTOR MANAGED SECTION -->
