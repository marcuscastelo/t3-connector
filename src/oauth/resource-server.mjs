import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { OAuthError } from './token-store.mjs';
import { json, readBody, redact } from './http.mjs';

// MCP resource server over Streamable HTTP (stateless, JSON responses). Global OAuth: every
// request, including initialize and tools/list, needs a valid access token of a live session.
//
// The public MCP server is a thin facade over inner catalogs reached through in-memory MCP pairs:
//   - shared sources: a long-lived inner server (the existing read catalog) with one client;
//   - per-request sources: registerTools(server, principal) on a fresh inner server, so handlers
//     get the verified principal by closure, never from tool arguments.
//   - per-invocation sources: discovery uses a request-local server, but each tools/call opens
//     its own server/context, including concurrent messages in one HTTP JSON-RPC batch.
// The facade enforces, per tools/call: scope (read-only tools need connector:read, the others
// connector:write), then admits activity (the only thing that restarts the idle window), forwards,
// and re-checks the session before releasing the result. initialize, tools/list, ping and
// notifications never count as activity.
// Only known MCP methods and names of tools that exist in the catalog go to the event log verbatim;
// anything else a client sends in those positions is logged as a hash, so a misplaced secret is not
// persisted. Before the catalog is resolved (request line, 401) tool names are always hashed.
const KNOWN_METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'prompts/list', 'logging/setLevel', 'completion/complete', 'server/discover', 'notifications/initialized', 'notifications/cancelled', 'notifications/progress', 'notifications/roots/list_changed']);

export function protectedResourceMetadata({ issuer, resource, scopes }) {
  return { resource, authorization_servers: [issuer], scopes_supported: scopes, bearer_methods_supported: ['header'], resource_name: 'T3 Connector' };
}

async function pair(server, name) {
  const client = new Client({ name, version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  return client;
}

export function sharedSource(server) {
  let ready;
  return { shared: true, client: () => (ready ??= pair(server, 'oauth-facade-shared')), close: async () => { if (ready) await (await ready).close(); } };
}
export function perRequestSource(registerTools, serverInfo = { name: 'oauth-inner', version: '1.0.0' }) {
  return { shared: false, async open(principal) { const s = new McpServer(serverInfo); registerTools(s, principal); const client = await pair(s, 'oauth-facade'); return { client, close: () => client.close() }; } };
}
export function perInvocationSource(createServer) {
  const source = { shared: false, async open(principal) {
    const client = await pair(createServer(principal), 'oauth-facade-invocation');
    return { client, close: () => client.close() };
  } };
  source.callTool = async (principal, params, options) => {
    const invocation = await source.open(principal);
    try { return await invocation.client.callTool(params, undefined, options); }
    finally { await invocation.close(); }
  };
  return source;
}

// `route` is the local path that serves MCP; by default the resource's own path. Behind a tunnel the
// canonical resource lives on the tunnel service and the local route stays /mcp. Metadata is served
// at the RFC 9728 well-known path for the route (and the root alias); the challenge points at the
// well-known URL of the canonical resource.
export function resourceServer({ issuer, resource, advertisedResource = null, route, scopes, tokens, authority, sources, serverInfo = { name: 't3-connector', version: '0.0.0' }, allowedOrigins = ['https://chatgpt.com'], audit = () => {} }) {
  const path = route ?? new URL(resource).pathname;
  // Metadata and challenge name the advertised resource when one is configured (tunnel mode); tokens
  // are still checked against `resource` only.
  const shown = advertisedResource ?? resource;
  const prmdUrl = `${new URL(shown).origin}/.well-known/oauth-protected-resource${new URL(shown).pathname}`;
  const prmd = protectedResourceMetadata({ issuer, resource: shown, scopes });

  function unauthorized(res, e, rpc) {
    const parts = [`Bearer resource_metadata="${prmdUrl}"`, `scope="${scopes.join(' ')}"`];
    if (e) parts.push('error="invalid_token"', `error_description="${e.description}"`);
    audit({ event: 'mcp_unauthorized', reason: e?.description ?? 'no_token', rpc });
    return json(res, 401, { error: e ? 'invalid_token' : 'unauthorized' }, { 'WWW-Authenticate': parts.join(', ') });
  }

  async function facade(principal) {
    const opened = [];
    const clients = await Promise.all(sources.map(async src => {
      if (src.shared) return { client: await src.client(), src };
      const o = await src.open(principal); opened.push(o); return { client: o.client, src };
    }));
    const catalog = new Map();
    for (const { client, src } of clients) {
      const { tools } = await client.listTools();
      for (const tool of tools) if (!catalog.has(tool.name)) catalog.set(tool.name, { tool, client, src });
    }
    const server = new Server(serverInfo, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...catalog.values()].map(e => e.tool) }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const name = req.params.name, entry = catalog.get(name);
      if (!entry) throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
      const needed = entry.tool.annotations?.readOnlyHint === true ? 'connector:read' : 'connector:write';
      if (!principal.scope.split(' ').includes(needed)) return { isError: true, content: [{ type: 'text', text: `insufficient_scope: ${needed}` }] };
      try { authority.admit(principal.sid); } catch (e) {
        audit({ event: 'tool_denied', tool: name, reason: e.message, sid: redact(principal.sid) });
        return { isError: true, content: [{ type: 'text', text: 'session_expired: reconnect the connector' }] };
      }
      audit({ event: 'tool_call', tool: name, sid: redact(principal.sid) });
      const params = { name, arguments: req.params.arguments ?? {} }, options = { signal: extra.signal, timeout: 15 * 60 * 1000 };
      const result = await (entry.src.callTool ? entry.src.callTool(principal, params, options) : entry.client.callTool(params, undefined, options));
      // Session revoked or expired while the call ran: the fetched result does not leave.
      try { authority.check(principal.sid); } catch (e) {
        audit({ event: 'tool_result_withheld', tool: name, reason: e.message, sid: redact(principal.sid) });
        return { isError: true, content: [{ type: 'text', text: 'session_expired: reconnect the connector' }] };
      }
      return result;
    });
    return { server, close: async () => { await server.close(); await Promise.all(opened.map(o => o.close())); } };
  }

  async function mcp(req, res) {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.includes(origin)) return json(res, 403, { error: 'origin_not_allowed' });
    // Stateless JSON mode: no standalone SSE stream and no transport session to delete.
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    const bearer = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(req.headers.authorization ?? '')?.[1];
    let body;
    try { const raw = await readBody(req, 1024 * 1024); body = raw ? JSON.parse(raw) : undefined; } catch (e) { if (e.status === 413) return json(res, 413, { error: 'body_too_large' }); body = null; }
    const msgs = Array.isArray(body) ? body : body ? [body] : [];
    const rpc = msgs.map(m => (m?.method === 'tools/call' ? `tools/call:${redact(m.params?.name)}` : m?.method === undefined ? 'response' : KNOWN_METHODS.has(m.method) ? m.method : `other:${redact(m.method)}`)).join(',') || 'empty';
    if (!bearer) return unauthorized(res, null, rpc);
    let principal;
    try { principal = tokens.resolveAccess(bearer); } catch (e) { if (e instanceof OAuthError) return unauthorized(res, e, rpc); throw e; }
    if (principal.resource !== resource) return unauthorized(res, new OAuthError('invalid_token', 'wrong_audience', 401), rpc);
    if (body === null) return json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    audit({ event: 'mcp_request', rpc, sid: redact(principal.sid) });
    const f = await facade(principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); f.close(); });
    await f.server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  return async function handle(req, res, url) {
    const p = url.pathname;
    if (p === '/.well-known/oauth-protected-resource' || p === `/.well-known/oauth-protected-resource${path}`) { json(res, 200, prmd); return true; }
    if (p === path) { await mcp(req, res); return true; }
    return false;
  };
}
