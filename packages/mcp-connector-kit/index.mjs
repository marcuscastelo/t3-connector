// Generic MCP tool plumbing shared by connectors. It knows nothing about T3, Fleet, OAuth or the
// transport: a connector creates its own McpServer and passes it here. Dependency direction is
// one way: connectors import this package; this package imports only zod (peer dependency, so the
// schemas and the strict wrapper come from the same zod copy as the connector's).

import { z } from 'zod';

/**
 * Returns `register(name, { shape, ...config }, handler)` bound to `server`. The input schema is
 * strict: an unknown parameter (for example a legacy or misspelled name) is refused by the SDK
 * instead of being silently dropped and the call running with defaults.
 */
export function strictRegistrar(server) {
  return (name, { shape, ...config }, handler) =>
    server.registerTool(name, { ...config, inputSchema: z.strictObject(shape ?? {}) }, handler);
}

/** Tool result carrying `data` both as pretty JSON text and as structuredContent. */
export function jsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data };
}

/** Tool error result: the client sees `message` and `isError: true`; nothing is thrown. */
export function errorResult(message) {
  return { content: [{ type: 'text', text: String(message) }], isError: true };
}

/**
 * Maps a thrown value to a tool error. Instances of the `expected` classes carry a message meant
 * for the client and pass through; anything else goes through `fallback`, so internal details
 * stay behind a connector-chosen prefix.
 */
export function toolErrorMapper({ expected = [], fallback = (e) => `unexpected error: ${e?.message ?? e}` } = {}) {
  return (e) => errorResult(expected.some((C) => e instanceof C) ? e.message : fallback(e));
}
