# runtimeMode passthrough: integration into `main`

Record for integrating the approved runtimeMode patch into local `main` after 0.11.1. This is
not a release. It does not change any version, tag, deploy or installed runtime.

## Need

At `main` = `origin/main` = `473dc01` (Release 0.11.1 merged), `8793347` was not an ancestor, and
`src/escrita/adapters.mjs` still hard-coded `full-access` in `thread.runtime-mode.set`,
`thread.launch` and `delegated_task.request`. The changes from `4301039` to `473dc01` touched only
the CIMD client cache, version constants and the CHANGELOG. They did not change runtime logic.

## Integration

- Before: `main` = `473dc01f119d36849a80a49a20a6f2775708679e`.
- `git cherry-pick -x 879334732be7939c07aecaa85c75be6c85e33767` (from local branch
  `fix/runtime-mode-passthrough`, which is preserved). The original author is kept, and the
  message carries `(cherry picked from commit 8793347…)`.
- Result: `51f3dd1f8b59ea9a83655a03e547b3cdecc6b611`. It changes 8 files, with 59 insertions and
  9 deletions.
- The cherry-pick did not stop on a conflict. Git auto-merged the CHANGELOG entry into the
  already released `## 0.11.1` section. The fix was a mechanical edit before amending: the entry
  moved under a new `## Unreleased` heading above `## 0.11.1`. The 0.11.1 content and every
  0.11.1 version constant stay unchanged. There is no version bump.
- Outside `CHANGELOG.md`, the `+`/`-` lines of `473dc01..51f3dd1` match those of `8793347`
  exactly.
- The later `fix/runtime-mode-passthrough` commits (`bda4953`, `63e5f92`, the 0.12 plan docs)
  were not imported.

## Validation (on `51f3dd1`, Node v22.22.3, npm 10.9.8, macOS)

- Focused tests (`escrita-adapters`, `escrita-actions`, `escrita-launch-model`,
  `oauth-native-tools`, `oauth-project-admin`): 93/93 pass.
- `npm test`: 537/537 pass, 0 fail, 0 skipped.
- `npm run test:package`: `t3-connector-0.11.1.tgz` ok: 67 files, isolated install, CLI and MCP
  handshake (9 tools).
- `git diff --check 473dc01 HEAD`: clean.
- `npm audit --json` (complete, without `--omit=dev`): exit 0. info 0, low 0, moderate 0,
  high 0, critical 0 (total 0) over 147 lockfile packages. The only devDependency,
  `@levischuck/tiny-cbor`, is also a transitive production dependency of
  `@simplewebauthn/server`, so npm counts it as prod (dev = 0). `npm audit --omit=dev`: 0
  vulnerabilities.
- `release:check` was not run: the `Unreleased` section is expected until the next release.

## Pending

- `main` holds these commits locally only. `origin/main` stays at `473dc01` until an authorized
  push or PR.
- Out of scope and still open: the upstream T3 `project.delete` race, which can orphan threads
  in a deleted project (see CHANGELOG 0.11.0). This integration does not touch it.
