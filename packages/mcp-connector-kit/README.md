# mcp-connector-kit

Shared layer for building MCP connectors, used by the T3 Connector (`t3-connector`, this
repository) and the Fleet Connector (`fleet`, `services/fleet-connector`). It holds everything a
connector needs except its domain: no T3, Fleet or other backend knowledge lives here.

| Entry | Contents |
| --- | --- |
| `mcp-connector-kit` | tool plumbing: `strictRegistrar` (unknown parameters refused), `jsonResult`, `errorResult`, `toolErrorMapper` |
| `mcp-connector-kit/oauth` | OAuth session profile: authorization server (PKCE S256, CIMD clients, `private_key_jwt`, resource-bound tokens, rotating refresh), MCP resource server over Streamable HTTP with `connector:read` / `connector:write` scopes per tool, sessions with idle window, maximum age, revocation and kill switch, local and public passkey sign-in, local control plane, bounded audit, `loadOAuthConfig` |
| `mcp-connector-kit/testing` | fake OAuth client, software WebAuthn authenticator and `startConnector` to drive the full sign-in and MCP calls in tests |

## Building a connector on it

```js
import { createOAuthConnector, loadOAuthConfig, perRequestSource } from 'mcp-connector-kit/oauth';

const config = loadOAuthConfig(process.env, { prefix: 'MY_CONNECTOR_OAUTH', app: 'my-connector' });
const connector = createOAuthConnector({
  config,
  brand: { name: 'My Connector', cookie: 'myc', passkeyUser: 'my-connector-oauth' },
  serverInfo: { name: 'my-connector', version: '1.0.0' },
  tools: () => ({ sources: [perRequestSource((server, principal) => registerMyTools(server, principal))] }),
});
await connector.listen();
```

A tool with `annotations.readOnlyHint: true` needs `connector:read`; any other needs
`connector:write`. Connector-specific options go through `loadOAuthConfig`'s `extend`/`validate`,
consent wording through `describeAccess`, and write policy approved at sign-in through the
`grantProvider` that `tools` may return.

## Dependencies and versioning

Runtime dependencies are peer dependencies (`@modelcontextprotocol/sdk`, `zod`,
`@simplewebauthn/server`, `@simplewebauthn/browser`, `qrcode`), so a connector and the kit share one
copy of each. Independent semver, released as `mcp-connector-kit-<version>.tgz` with a `.sha256`
(tag `mcp-connector-kit-vX.Y.Z`, `.github/workflows/release-kit.yml`). Consumers pin the exact
version. The T3 Connector bundles it in its own tarball.

0.1.0 had only the tool plumbing; 0.2.0 adds the OAuth session profile and the test support.
