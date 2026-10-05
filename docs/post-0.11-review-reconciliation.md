# Post-0.11 review reconciliation

Status: reconciliation record. Documentation only; it does not change code, versions or releases.

- Baseline: `main` at `4301039`, released as `0.11.0`.
- Local branch: `fix/runtime-mode-passthrough` at `8793347` (not pushed, not merged, not released).
- Inventory and analysis: parent GPT thread. This document persists those conclusions; it was written without new code discovery.

## 1. Review `518f83c8-9a9c-4661-bac6-e3eae629be48`

### 1.1 High finding: worktree launch — superseded

Superseded by `cb3ce83` and `f06685a`, both on `main` before `0.11.0`.

- The dispatcher forwards `workspaceStrategy` of type `worktree` with `baseRef`, `branch` and `startFromOrigin` as-is.
- `test/escrita-adapters` and `oauth-native-tools` cover the lease wire and the OAuth wire.
- `root` and approved `existing_worktree` strategies are preserved.
- Evidence: wrapper forwarding is proven with fixtures. No live worktree creation is claimed.

### 1.2 Medium finding: runtime mode — persists on `main`, corrected locally

The finding still applies to `main` (`4301039`, `0.11.0`). It is corrected locally in `8793347`. Claude committed that change by adopting the diff the parent had prepared before its instructions:

- `runtimeMode` is optional and accepts its 4 native values.
- When omitted, it defaults to `full-access` on `thread.launch`, `delegated_task.request` and `thread.runtime-mode.set`.
- `interactionMode` is not changed.
- T3 owns validation of provider support for each runtime mode; the connector does not duplicate it.

Verification:

- Parent independently reviewed the diff and reproduced the 104 relevant tests.
- Claude ran `npm test` (535 pass) and the package check (pass).
- The release check refuses because `Unreleased` is not empty. The release dry run exits 0 but prints the same failure. No release was made.

### 1.3 Disposition

This review may be settled as "historical findings reconciled". The integration of the runtime fix into `main` is still pending and is tracked here. Do not claim that `main` fixes the runtime finding until `8793347` (or an equivalent change) is merged.

## 2. Delete review `562f2204-6253-4797-a940-da660dfd2711` (of `dbcadc3`)

### 2.1 Findings superseded by `33575b8`

| Finding | Subject | Current state (exact tests in `oauth-project-admin`) |
|---|---|---|
| 2 | Stale `force` guard | The `force` count runs last, after `validateTarget`. |
| 3 | Malformed count | Malformed rows make the count incomplete instead of reading as zero. |
| 4 | Replay diagnostic loss | Replay keeps the receipt and the postcheck. |
| 5 | Stale session tool offer | An old grant hides the project tools. |

### 2.2 Race windows

There are two distinct windows. Keep them separate:

1. **Before native child enumeration.** The native `force:false` refusal protects this window. The connector's own launch and delete calls are serialized against each other.
2. **After native child enumeration, before the project commit.** A child thread created externally in this window is an upstream bug. The connector postcheck detects it but does not eliminate it. Docs and tests explicitly model the resulting live orphan.

Source evidence for window 2:

- The installed Polaris build was read from its actual `Info.plist`: nightly `.2652`. Its published source, `4ee6bfd50ef4a089440d5c3662db2298da9cc50e`, was captured locally.
  - `ProjectService.ts:454-504`: child enumeration runs outside the project lock.
  - `ProjectService.ts:265`: the commit takes the lock.
  - `Orchestrator.ts:2127-2198`: thread creation emits without checking project existence or `deletedAt`.
- Source `.2657` (`efecd3cf8bcec3d1891b5f5a27dc2f6d797c6448`), cited in a prior report, has the same relevant project code. This does **not** claim that live Sirius was verified.

Limits of the evidence:

- No backend mutation reproduction was performed. A deterministic connector simulator demonstrates the window; the source establishes the missing invariant.
- Zero-orphan safety cannot be claimed as certified.
- No upstream change was authorized or implemented. No new connector-side safety boxing is added.

## 3. Review dispositions

| Review | Disposition |
|---|---|
| `518f83c8-9a9c-4661-bac6-e3eae629be48` | May be settled after this record of the local correction and of the pending explicit `main` integration. |
| `c79d2d84-bc5c-4191-a036-7704040b3935` (canonical contract) | Keep open. Retains one real pending item: the upstream zero-live-orphan invariant. |
| `562f2204-6253-4797-a940-da660dfd2711` (independent delete) | Keep open for the same single upstream invariant. Findings 2–5 are superseded (section 2.1). |
| `a42caf79…` (duplicate) | Already settled. |
| `904f7869…` | Interrupted and already settled. It is not a completed, accepted review. |

Do not settle `c79d2d84…` or `562f2204…` under their original zero-orphan gate until an upstream fix lands or an explicit product decision changes that criterion.

The parent has not settled any old thread automatically. This record does not dispose of any unrelated review.
