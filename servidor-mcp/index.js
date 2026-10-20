import { serve } from '@hono/node-server';
import { criarServidorMcp } from './server.js';

const app = criarServidorMcp();
const port = Number(process.env.MCP_PORT ?? 7301);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port },
  info => console.error(`MCP http://127.0.0.1:${info.port}/mcp`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await app.close();
  server.close();
});
