import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { OAuthError } from './token-store.mjs';
import { json, readBody, redact } from './http.mjs';

// MCP resource server over Streamable HTTP (stateless, JSON responses). Global OAuth: every
// request, including initialize and tools/list, needs a valid access token of a live session.
//
// Activity: only an authorized tools/call that reaches its handler (schema already validated by the
// SDK) counts, through authority.admit(). initialize, tools/list, ping, notifications and refresh
// never extend the session. Read-only tools need connector:read; every other tool connector:write.
export function protectedResourceMetadata({ issuer, resource, scopes }) {
  return { resource, authorization_servers: [issuer], scopes_supported: scopes, bearer_methods_supported: ['header'], resource_name: 'T3 Connector' };
}

export function resourceServer({ issuer, resource, scopes, tokens, authority, registerTools, serverInfo = { name: 't3-connector', version: '0.0.0' }, allowedOrigins = ['https://chatgpt.com'], audit = () => {} }) {
  const prmdUrl = `${new URL(resource).origin}/.well-known/oauth-protected-resource${new URL(resource).pathname}`;
  const prmd = protectedResourceMetadata({ issuer, resource, scopes });

  function unauthorized(res, e, rpc) {
    const parts = [`Bearer resource_metadata="${prmdUrl}"`, `scope="${scopes.join(' ')}"`];
    if (e) parts.push('error="invalid_token"', `error_description="${e.description}"`);
    audit({ event: 'mcp_unauthorized', reason: e?.description ?? 'no_token', rpc });
    return json(res, 401, { error: e ? 'invalid_token' : 'unauthorized' }, { 'WWW-Authenticate': parts.join(', ') });
  }

  // Wraps registerTool so every handler re-checks the session, enforces scope and records activity.
  function guardedServer(principal) {
    const server = new McpServer(serverInfo);
    const register = server.registerTool.bind(server);
    server.registerTool = (name, config, handler) => {
      const needed = config?.annotations?.readOnlyHint === true ? 'connector:read' : 'connector:write';
      return register(name, config, async (...args) => {
        if (!principal.scope.split(' ').includes(needed)) return { isError: true, content: [{ type: 'text', text: `insufficient_scope: ${needed}` }] };
        try { authority.admit(principal.sid); } catch (e) {
          audit({ event: 'tool_denied', tool: name, reason: e.message, sid: redact(principal.sid) });
          return { isError: true, content: [{ type: 'text', text: 'session_expired: reconnect the connector' }] };
        }
        audit({ event: 'tool_call', tool: name, sid: redact(principal.sid) });
        return handler(...args);
      });
    };
    registerTools(server, principal);
    return server;
  }

  async function mcp(req, res) {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.includes(origin)) return json(res, 403, { error: 'origin_not_allowed' });
    if (req.method !== 'POST') {
      // Stateless JSON mode: no standalone SSE stream and no session to delete.
      return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    }
    const bearer = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(req.headers.authorization ?? '')?.[1];
    let body;
    try { const raw = await readBody(req, 1024 * 1024); body = raw ? JSON.parse(raw) : undefined; } catch (e) { if (e.status === 413) return json(res, 413, { error: 'body_too_large' }); body = null; }
    const msgs = Array.isArray(body) ? body : body ? [body] : [];
    const rpc = msgs.map(m => (m?.method === 'tools/call' ? `tools/call:${String(m.params?.name ?? '').slice(0, 64)}` : String(m?.method ?? 'response').slice(0, 64))).join(',') || 'empty';
    if (!bearer) return unauthorized(res, null, rpc);
    let principal;
    try { principal = tokens.resolveAccess(bearer); } catch (e) { if (e instanceof OAuthError) return unauthorized(res, e, rpc); throw e; }
    if (principal.resource !== resource) return unauthorized(res, new OAuthError('invalid_token', 'wrong_audience', 401), rpc);
    if (body === null) return json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    audit({ event: 'mcp_request', rpc, sid: redact(principal.sid) });
    const server = guardedServer(principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  return async function handle(req, res, url) {
    const p = url.pathname;
    if (p === '/.well-known/oauth-protected-resource' || p === `/.well-known/oauth-protected-resource${new URL(resource).pathname}`) { json(res, 200, prmd); return true; }
    if (p === new URL(resource).pathname) { await mcp(req, res); return true; }
    return false;
  };
}
