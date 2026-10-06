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

## Several connectors on one host: mounted issuer

The issuer may carry a mount path, so two authorization servers share one HTTPS host behind an
ingress that routes by path: `<prefix>_ISSUER=https://host.example/fleet` (lowercase segments
`[a-z0-9][a-z0-9-]*`, no trailing slash, query or fragment; `config.mount` is `/fleet`). Without a
path the behavior is that of 0.2.0, pinned by a snapshot test (`test/fixtures/surface-0.2.0.json`).

| | without mount | with mount `/fleet` |
| --- | --- | --- |
| AS discovery | `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`, `/.well-known/oauth-authorization-server/mcp` | `/.well-known/oauth-authorization-server/fleet`, `/.well-known/openid-configuration/fleet`, `/fleet/.well-known/openid-configuration`, `/.well-known/oauth-authorization-server/fleet/mcp` |
| Endpoints, login pages, enrollment link | `/authorize`, `/token`, `/revoke`, `/resume`, `/enroll`, ... | the same under `/fleet/` |
| Resource and its metadata (RFC 9728) | `<issuer>/mcp`, `/.well-known/oauth-protected-resource/mcp` and the root alias | `<issuer>/mcp` = `/fleet/mcp`, `/.well-known/oauth-protected-resource/fleet/mcp`; no root alias on the public listener (it belongs to the host) |
| WebAuthn origin, `Origin` check | the issuer | the bare origin (`https://host.example`); the rpID is the hostname in both cases |

Every other path gets 404, so a wrong ingress rule fails closed instead of answering for the other
connector. The ingress picks the owner from the raw request-target, so a mounted connector routes only
origin-form targets whose path the URL parser keeps as is: dot segments (`.`, `..`, `%2e`),
backslashes, `//authority` and absolute-form targets get 404 instead of being normalized into or out
of the mount. Without a mount, request-targets are parsed as in 0.2.0. Tokens are per process and bound
to the resource. A client assertion is accepted only when every `aud` value names this issuer
(`<issuer>/token`, `<issuer>/revoke` or `<issuer>`), so one naming two issuers is refused by both;
this holds with or without a mount. The transaction cookie stays
`__Host-<brand.cookie>_tx` with `Path=/` (the `__Host-` prefix requires it), so a mounted connector
needs a `brand.cookie` of its own: `createOAuthConnector` refuses the default one. Each connector keeps
its own state directory; the public passkey file is tagged with the full issuer, so a state directory
cannot be reused under another mount. Ingress rule for `/fleet` (e.g. a Cloudflare tunnel path):
`^/(fleet|\.well-known/(oauth-authorization-server|openid-configuration|oauth-protected-resource)/fleet)(/.*)?$`.
In tests, `startConnector({ mount: '/fleet' })` serves the connector at `http://localhost:<port>/fleet`.

## Dependencies and versioning

Runtime dependencies are peer dependencies (`@modelcontextprotocol/sdk`, `zod`,
`@simplewebauthn/server`, `@simplewebauthn/browser`, `qrcode`), so a connector and the kit share one
copy of each. Independent semver, released as `mcp-connector-kit-<version>.tgz` with a `.sha256`
(tag `mcp-connector-kit-vX.Y.Z`, `.github/workflows/release-kit.yml`). Consumers pin the exact
version. The T3 Connector bundles it in its own tarball.

0.1.0 had only the tool plumbing; 0.2.0 adds the OAuth session profile and the test support;
0.3.0 accepts an issuer mounted on a path.
