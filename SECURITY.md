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
- the lease approval/local administrative page reachable outside `localhost`, or the relay accepted without the
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

OAuth public sign-in uses a second RP fixed to the HTTPS issuer origin/hostname, separate tagged
credential storage and the existing canonical subject. The original local credential remains
administrative. UV precedes private inventory and explicit consent. Cookie-bound live
transactions, purpose-bound ≤120 s single-use challenges, exact Origin/JSON and Fetch Metadata
checks, counter/UP/UV/signature checks and crossOrigin/topOrigin refusal apply to ceremonies.
GET never approves or enrolls; existing OAuth navigation effects remain.

Public enrollment exposes a distinct remote ceremony only during a locally authorized window.
Action-bound local UV issues a digest-only ephemeral 128-bit capability; the first valid claim
binds one browser/generation, ≤15 min. Replacement, kill, revoke-all, restart and success cancel
it; guarded synchronous persistence prevents late commit. All public enrollment paths are 404
otherwise. A stolen link authorizes adding a credential, so protect links/QRs. Public credentials
cannot administer enrollment/removal; no public SIGUSR2 or automatic bootstrap. Per-RP deletion
ends that key's sessions/tokens and pending approvals and blocks in-flight counter restoration.
Deletion reserves bounded queue capacity and persists intent before accepting revocation. A
failed/pending key remains disabled across restart; fresh local action-bound UV can finish its
removal. Counter/registration commits retain outstanding intents. Overload or initial-intent
storage failure rejects admission without claiming revocation; retry requires a fresh proof.

CSP/nonces, frame denial, no-referrer/no-store/nosniff and host-only Secure/HttpOnly/Lax cookies
protect issuer pages; app maps/queues/verification/body/connection limits and deadlines are finite.
Audit rotation and rejection aggregation never retain ticket/cookie/assertion/code/token values.
See [OAuth limits and ingress policy](docs/oauth-session.md#52-admission-resource-bounds-and-ingress-requirements):
the edge must enforce client throttles, path isolation, TLS, deadlines and secret-free logging.
Application budgets use the socket peer and trust no forwarded identity. The software-authenticator
tests do not establish Cloudflare, Android/Bitwarden or hosted ChatGPT compatibility.
