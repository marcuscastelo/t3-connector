# Releasing

A release is a Git tag `vX.Y.Z` on `main` and a GitHub Release carrying the `npm pack`
artifact `t3-connector-X.Y.Z.tgz` and its `.sha256`. The package is not published to npm.
Publishing a release never touches a running connector: updating an installation is a
separate, manual step (below).

## 1. Prepare (pull request to `main`)

Set the same version in every place that declares it:

- `package.json` and `package-lock.json` (`npm version X.Y.Z --no-git-tag-version`
  updates both);
- `VERSAO` in `src/servidor.mjs` and `VERSAO_ESCRITA` in `src/escrita/ponte-mcp.mjs`.

In `CHANGELOG.md`, move the entries of `## Unreleased` under a new `## X.Y.Z` heading and
leave `## Unreleased` empty. Then, locally:

```sh
npm test
npm run release:dry-run    # same checks and packaging as the workflow, publishes nothing
```

The dry run checks that the version, lock, `VERSAO`, `VERSAO_ESCRITA` and CHANGELOG
agree, packs once, runs the package check (`scripts/check-package.mjs --tgz`) on that
artifact and prints the release notes. Merge the pull request once CI is green.

## 2. Publish (tag)

```sh
git switch main && git pull --ff-only
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

`.github/workflows/release.yml` then:

1. `verify`: the tagged commit is on `main` and `scripts/release.mjs check --tag` passes;
2. `ci`: runs the CI workflow (Linux and macOS, Node 22.13 and 24) through `workflow_call`;
3. `package`: packs once, writes the checksum and notes, runs the package check on that
   exact `.tgz` and uploads it as a workflow artifact;
4. `publish` (environment `release`, the only job with `contents: write`): verifies the
   checksum and creates the GitHub Release with the `.tgz` and `.sha256`. A tag with a
   suffix (`v1.0.0-rc.1`) becomes a pre-release.

To require a manual approval before publishing, add required reviewers to the `release`
environment in the repository settings. If a job fails, nothing is published: fix on
`main`, delete the tag (`git push origin :refs/tags/vX.Y.Z`; `git tag -d vX.Y.Z`) and
tag again. A published release is not overwritten; ship a new patch version instead.

## 3. Update a running installation (manual, explicit approval)

No workflow updates a running connector. Whoever operates the installation decides to
update it, after reading the release notes:

```sh
gh release download vX.Y.Z --repo marcuscastelo/t3-connector \
  --pattern 't3-connector-X.Y.Z.tgz*' --dir /tmp/t3-connector-X.Y.Z
node scripts/release.mjs verify-asset /tmp/t3-connector-X.Y.Z/t3-connector-X.Y.Z.tgz --version X.Y.Z
```

`verify-asset` checks the `.sha256` and the version inside the artifact. Install it next
to the current one, not over it, keeping the previous `.tgz`:

```sh
npm install --omit=dev --ignore-scripts --prefix <new-dir> /tmp/t3-connector-X.Y.Z/t3-connector-X.Y.Z.tgz
```

Point the MCP client or tunnel profile at `<new-dir>/node_modules/.bin/t3-connector serve`
(and `t3-connector-write bridge`/`gate` for writes), then restart them. If your deployment
has its own approval gate for the installed artifact, it applies here.

Verify after the switch:

- `t3-connector --version` and `t3-connector-write --version` print `X.Y.Z`;
- `t3-connector diagnose` reaches every configured environment;
- the client lists the expected tools and one read call (e.g. `t3_ambientes`) succeeds;
- for writes: the gate's approval page loads and a lease can be approved.

Rollback: point the client or tunnel profile back at the previous installation (or
reinstall the previous release's `.tgz`, verified the same way) and restart. Releases do
not migrate configuration or state, so rolling back needs no data step unless the
release notes say otherwise.
