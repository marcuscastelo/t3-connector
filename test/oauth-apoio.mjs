// Test harness for the OAuth session profile: the generic one from mcp-connector-kit/testing, run
// with the T3 Connector's branded composition and the rehearsal tools by default.
import { startConnector as start } from 'mcp-connector-kit/testing';
import { createOAuthConnector } from '../src/oauth/connector.mjs';
import { rehearsalTools } from '../src/oauth/rehearsal-tools.mjs';
import { perRequestSource } from '../src/oauth/resource-server.mjs';
export { freePort, http, setHttpTimeout } from 'mcp-connector-kit/testing';

export const startConnector = (options = {}) => start({
  create: createOAuthConnector,
  tools: () => ({ sources: [perRequestSource(rehearsalTools())] }),
  serverInfo: { name: 't3-connector-test', version: '0.0.0' },
  ...options,
});
