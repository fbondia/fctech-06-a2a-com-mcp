import test from 'node:test';
import assert from 'node:assert/strict';
import { criarServidorMcp, criarCodec } from '../servidor-mcp/server.js';
import { mcp, meta, pedido, retry, secret } from './helpers.js';

function appDe(t, opts = {}) {
  const app = criarServidorMcp({ secret: secret(), log: () => {}, ...opts });
  t.after(app.close);
  return app;
}
const reservar = (app, args = pedido(), opts) => mcp(app, 'tools/call', { name: 'reservar_sala', arguments: args }, opts);

test('metadata e obrigatoria em cada request e headers incoerentes sao -32020', async t => {
  const app = appDe(t);
  assert.equal((await mcp(app, 'tools/list', {})).status, 200);
  for (const key of Object.keys(meta)) {
    const incompleta = { ...meta }; delete incompleta[key];
    const r = await mcp(app, 'tools/list', {}, { meta: incompleta });
    assert.equal(r.status, 400); assert.equal(r.body.error.code, -32602);
  }
  for (const headers of [{ 'MCP-Protocol-Version': '2025-11-25' }, { 'Mcp-Method': 'resources/list' },
    { 'Mcp-Name': 'consultar_disponibilidade' }]) {
    const r = await reservar(app, pedido(), { headers });
    assert.equal(r.status, 400); assert.equal(r.body.error.code, -32020);
  }
});

test('resource/schema/resultados e logs conservam o contrato sem registrar estado', async t => {
  const logs = []; const app = appDe(t, { log: linha => logs.push(JSON.parse(linha)) });
  const list = await mcp(app, 'tools/list', {});
  assert.equal(list.body.result.tools.length, 3);
  for (const tool of list.body.result.tools) assert.equal(tool.inputSchema.type, 'object');
  assert.ok(list.body.result.tools.find(x => x.name === 'listar_salas').outputSchema);
  const result = (await mcp(app, 'tools/call', { name: 'listar_salas', arguments: {} })).body.result;
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  const ocupada = (await mcp(app, 'tools/call', {
    name: 'consultar_disponibilidade', arguments: pedido(),
  })).body.result;
  assert.deepEqual(ocupada.structuredContent, { sala: 'sala-garagem', livre: false,
    conflitos: [{ id: 'res-0001', inicio: pedido().inicio, fim: pedido().fim, responsavel: 'Marty' }] });
  assert.deepEqual(JSON.parse(ocupada.content[0].text), ocupada.structuredContent);
  const resource = (await mcp(app, 'resources/read', { uri: 'politica://uso' })).body.result;
  assert.equal(resource.contents[0].mimeType, 'text/markdown');
  assert.ok(resource.contents[0].text.startsWith('versao: 2026-11-01'));
  assert.equal((await mcp(app, 'resources/read', { uri: 'politica://ausente' })).body.error.code, -32602);
  const traceparent = '00-12345678901234567890123456789012-1234567890123456-01';
  const pausa = (await reservar(app, pedido(), { meta: { ...meta, traceparent } })).body.result;
  assert.equal(logs.at(-1).traceparent, traceparent);
  assert.equal(logs.at(-1).method, 'tools/call'); assert.ok(logs.at(-1).id);
  assert.equal(JSON.stringify(logs).includes(pausa.requestState), false);
});

test('capability deve declarar form e nao e herdada de request anterior', async t => {
  const app = appDe(t);
  assert.equal((await reservar(app)).body.result.resultType, 'input_required');
  for (const caps of [{}, { elicitation: { url: {} } }]) {
    const r = await reservar(app, pedido(), { meta: { ...meta, 'io.modelcontextprotocol/clientCapabilities': caps } });
    assert.equal(r.status, 400); assert.equal(r.body.error.code, -32021);
    assert.ok(r.body.error.data.requiredCapabilities.elicitation.form);
  }
});

test('MRTR valida chave, enum e tool; decline/cancel nunca criam reservas', async t => {
  const app = appDe(t); const args = pedido();
  const pausa = (await reservar(app)).body.result;
  for (const action of ['decline', 'cancel']) {
    const r = await mcp(app, 'tools/call', retry(args, pausa, action));
    assert.equal(r.body.result.structuredContent.reservado, false);
    assert.equal(r.body.result.isError, false);
  }
  for (const params of [retry(args, pausa, 'accept', 'sala-aquario'),
    { ...retry(args, pausa), inputResponses: { errada: { action: 'decline' } } },
    { ...retry(args, pausa), name: 'listar_salas', arguments: {} }]) {
    const response = (await mcp(app, 'tools/call', params)).body;
    assert.ok(response.error?.code === -32602 || response.result?.isError === true);
  }
  const novo = (await mcp(app, 'tools/call', retry({ ...args, responsavel: 'Invasor' }, pausa))).body.result;
  assert.equal(novo.structuredContent.responsavel, 'Doc');
  assert.equal(novo.structuredContent.inicio, args.inicio);
});

test('requestState detecta adulteracao e expiracao sem aguardar dez minutos', async t => {
  const key = secret(); const app = appDe(t, { secret: key });
  const pausa = (await reservar(app)).body.result;
  const wire = pausa.requestState;
  const envelope = JSON.parse(Buffer.from(wire.split('.')[1], 'base64url').toString());
  assert.ok(Math.abs(envelope.exp * 1000 - Date.now() - 600000) < 2000);
  const bad = wire.slice(0, -6) + (wire.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA');
  assert.equal((await mcp(app, 'tools/call', { ...retry(pedido(), pausa), requestState: bad })).body.error.code, -32602);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now - 601000);
  const codec = criarCodec(key);
  const expired = await codec.mint(envelope.p, { mcpReq: { method: 'tools/call' } });
  t.mock.restoreAll();
  const r = await mcp(app, 'tools/call', { ...retry(pedido(), pausa), requestState: expired });
  assert.equal(r.body.error.code, -32602);
  assert.match(r.body.error.message, /Invalid or expired requestState/);
});

test('configuracao falha sem secret de pelo menos 32 bytes', () => {
  for (const key of [undefined, '', 'abc', 'ab'.repeat(31)]) assert.throws(() => criarCodec(key), /REQUEST_STATE_SECRET/);
  assert.ok(criarCodec(secret()));
});
