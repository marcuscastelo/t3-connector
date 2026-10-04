# Security policy

## Supported versions

Only the latest version on the default branch receives security fixes.

## Reporting a vulnerability

Do not open a public issue. Use **Security → Report a vulnerability** (GitHub Private
Vulnerability Reporting) in this repository. Include the version, the relevant
configuration (without tokens), steps to reproduce and the expected impact. Expect an
initial answer within 7 days.

## Scope

Of particular interest:

- writes without a valid lease, a lease widened beyond the scope approved with the
  passkey, or reused after expiry/revocation;
- reads outside `allowedProjects` (stdio/restricted OAuth read connector) or outside the lease grant (guarded
  reads of the write connector);
- acceptance of a token with scopes other than the required ones (`orchestration:read`
  for reads; `orchestration:read` + `orchestration:operate` for writes);
- leaking tokens, pairing codes, the relay capability or message text into logs, MCP
  stdout or tool responses;
- the approval page reachable outside `localhost`, or the relay accepted without the
  capability;
- injection through the configured SSH host.

Out of scope: vulnerabilities in T3 Code itself, the MCP SDK, the tunnel client or the
client calling the connector. Report those to the respective projects.

## Threat model summary

- The connector runs on the operator's machine, with per-environment tokens stored in
  mode-600 files outside the repository. No secret comes from Git.
- HTTP only on loopback; remote environments through HTTPS or an `ssh -L` tunnel opened
  by the connector itself.
- The read connector never accepts a token with write scope.
- The write connector only dispatches with a 60-minute lease approved with a passkey
  (WebAuthn, user verification required) on the local page. The lease lives in memory:
  restarting the gate ends it.
- The passkey approves the scope shown on the page. It does not prove the intent of
  whoever created the request; read the scope before approving.

OAuth `T3_CONNECTOR_OAUTH_PROJECTS=all` intentionally consents to read and write every current
and future project of the configured environments. New projects enter automatically; there is no
project allowlist or per-action passkey approval. Effective OAuth scopes still restrict read/write.
A compromised active bearer or prompt injection can reach all projects of those hosts; human
restrictions on actions remain policy. Sessions retain one-hour idle expiry, local revoke and
kill checks. Live inventory, thread ownership, current workspace roots, configured environment
identity/destination and journal semantics remain enforced per operation. The final GET and
mutation RPC are not atomic; stronger ownership guarantees need backend support. The shared
stdio config and Ponte lease behavior are unaffected.
