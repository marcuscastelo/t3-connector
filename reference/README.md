# reference/

Verbatim, unmodified copy of one T3 Code source file, used only by the tests
(`test/escrita-actions.test.mjs`) to check that the connector's 42 write actions match the
commands of the `OrchestrationV2Command` contract. It is not part of the npm package
(`files` in `package.json`) and is never loaded at runtime.

| File | Origin |
|---|---|
| `packages_contracts_src_orchestrationV2.ts` | `packages/contracts/src/orchestrationV2.ts` from <https://github.com/pingdotgg/t3code>, commit `8ed276c246b624631e7d39241ebfd22d8314cb68` (2026-10-02) |

SHA-256 of the file: `3cdca572cc72142d4cccf6bc35e79c75dad60cd700b5758cb43790ff6b63cfbc`
(identical to the upstream blob at that commit).

## License

T3 Code is distributed under the MIT License, Copyright (c) 2026 T3 Tools Inc. The full
upstream license text is in [`LICENSE.t3code`](LICENSE.t3code) and applies to this file.
The rest of this repository is covered by the root [`LICENSE`](../LICENSE).

## Updating

Copy the file from the T3 Code commit the connector was tested against, update the commit
and SHA-256 above, and run `npm test`.
