import { randomBytes, randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { once } from 'node:events';

export const secret = () => randomBytes(32).toString('hex');
export const h = hora => `2026-11-03T${hora}:00-03:00`;
export const pedido = (sala = 'sala-garagem', de = '14:00', ate = '15:00') => ({
  sala, inicio: h(de), fim: h(ate), responsavel: 'Doc',
});
export const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
};
export function requestMcp(method, params = {}, options = {}) {
  const body = { jsonrpc: '2.0', id: randomUUID(), method, params: { ...params,
    _meta: options.meta ?? meta } };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method };
  if (method === 'tools/call') headers['Mcp-Name'] = params.name;
  if (method === 'resources/read') headers['Mcp-Name'] = params.uri;
  return new Request(options.url ?? 'http://127.0.0.1/mcp', { method: 'POST',
    headers: { ...headers, ...options.headers }, body: JSON.stringify(body) });
}
export async function mcp(app, method, params, options) {
  const response = await app.fetch(requestMcp(method, params, options));
  return { status: response.status, body: await response.json() };
}
export function retry(args, result, action = 'accept', sala = 'sala-fusca') {
  const chave = Object.keys(result.inputRequests)[0];
  return { name: 'reservar_sala', arguments: args, requestState: result.requestState,
    inputResponses: { [chave]: action === 'accept' ? { action, content: { sala } } : { action } } };
}
export async function servir(t, app) {
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(async () => {
    await app.close();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
export async function enviar(app, texto, taskId, traceparent) {
  return a2a(app, 'SendMessage', { message: { messageId: randomUUID(), role: 'ROLE_USER',
    parts: [{ text: texto }], ...(taskId ? { taskId } : {}) } }, traceparent);
}
export async function a2a(app, method, params, traceparent) {
  const response = await app.fetch(new Request('http://127.0.0.1/a2a', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(traceparent ? { traceparent } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) }));
  return response.json();
}
export const textoPedido = args => `reservar sala=${args.sala} inicio=${args.inicio} fim=${args.fim} responsavel=${args.responsavel}`;
