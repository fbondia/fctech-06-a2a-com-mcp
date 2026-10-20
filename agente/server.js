import { criarTasks, ErroA2a } from './tasks.js';

export function criarAgente({ mcpUrl = process.env.MCP_URL ?? 'http://127.0.0.1:7301/mcp',
  publicUrl = process.env.AGENT_URL ?? `http://127.0.0.1:${process.env.AGENT_PORT ?? 7300}` } = {}) {
  const tasks = criarTasks({ mcpUrl });
  const card = {
    name: 'Central de Salas', description: 'Reserva salas de reuniao da Hill Valley Tech.',
    provider: { organization: 'Hill Valley Tech', url: 'https://hillvalley.example' }, version: '1.0.0',
    supportedInterfaces: [{ url: `${publicUrl.replace(/\/$/, '')}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 'reservar-sala', name: 'Reservar sala',
      description: 'Reserva uma sala em um intervalo. Se houver conflito, pergunta qual alternativa usar.',
      tags: ['salas', 'agenda'], inputModes: ['text/plain'], outputModes: ['text/plain'],
      examples: ['reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty'] }],
  };
  return {
    close: tasks.close,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/.well-known/agent-card.json' && request.method === 'GET') return Response.json(card);
      if (path !== '/a2a') return new Response('Not found', { status: 404 });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      let rpc;
      try {
        try { rpc = await request.json(); } catch { throw new ErroA2a(-32700, 'Parse error'); }
        if (rpc?.jsonrpc !== '2.0' || typeof rpc.method !== 'string'
          || !(typeof rpc.id === 'string' || typeof rpc.id === 'number')) {
          throw new ErroA2a(-32600, 'Invalid Request');
        }
        let task;
        if (rpc.method === 'SendMessage') task = await tasks.send(rpc.params?.message, request.headers.get('traceparent'));
        else if (rpc.method === 'GetTask') task = tasks.get(rpc.params?.id);
        else throw new ErroA2a(-32601, 'Method not found');
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { task } });
      } catch (e) {
        return Response.json({ jsonrpc: '2.0', id: rpc?.id ?? null, error: {
          code: e instanceof ErroA2a ? e.code : -32603,
          message: e instanceof ErroA2a ? e.message : 'Internal error',
        } });
      }
    },
  };
}
