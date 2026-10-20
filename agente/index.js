import { serve } from '@hono/node-server';
import { criarAgente } from './server.js';

const app = criarAgente();
const port = Number(process.env.AGENT_PORT ?? 7300);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port },
  info => console.error(`A2A http://127.0.0.1:${info.port}/a2a`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await app.close();
  server.close();
});
