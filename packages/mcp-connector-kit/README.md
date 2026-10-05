# mcp-connector-kit

Generic MCP tool plumbing shared by the T3 Connector (`t3-connector`, this repository) and the
Fleet Connector (`fleet`, `services/fleet-connector`). Nothing here knows about T3, Fleet, OAuth or
the transport; each connector creates its own `McpServer` and keeps its domain code.

| Export | Purpose |
| --- | --- |
| `strictRegistrar(server)` | `register(name, { shape, ...config }, handler)` with `z.strictObject(shape)`: unknown parameters are refused |
| `jsonResult(data)` | result with pretty JSON text and `structuredContent` |
| `errorResult(message)` | result with `isError: true` |
| `toolErrorMapper({ expected, fallback })` | thrown value → error result; `expected` classes pass their message through |

`zod` is a peer dependency so schemas and the strict wrapper share one zod copy.

Versioning: independent semver, released as `mcp-connector-kit-<version>.tgz` with a `.sha256`
next to it. Consumers pin the exact version. The T3 Connector bundles it in its own tarball, so
installing `t3-connector` still takes a single artifact.
