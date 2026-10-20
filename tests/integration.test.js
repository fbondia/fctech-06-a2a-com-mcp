import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { criarServidorMcp } from '../servidor-mcp/server.js';
import { criarAgente } from '../agente/server.js';
import { criarTasks } from '../agente/tasks.js';
import { McpHost } from '../agente/mcp-host.js';
import { enviar, a2a, mcp, meta, pedido, retry, secret, servir, textoPedido, requestMcp } from './helpers.js';

const state = response => response.result.task.status.state.replace('TASK_STATE_', '');
const artifact = response => JSON.parse(response.result.task.artifacts[0].parts[0].text);

test('ponte HTTP isola Tasks, preserva estado/trace, headers e id novo no retry', async t => {
  const requests = []; const logs = [];
  const server = criarServidorMcp({ secret: secret(), log: line => logs.push(JSON.parse(line)) });
  const url = await servir(t, { close: server.close, fetch: async request => {
    requests.push({ body: await request.clone().json(), headers: request.headers });
    return server.fetch(request);
  } });
  const agent = criarAgente({ mcpUrl: `${url}/mcp` }); t.after(agent.close);
  const traceA = '00-11111111111111111111111111111111-1111111111111111-01';
  const traceB = '00-22222222222222222222222222222222-2222222222222222-01';
  const argsA = pedido(); const argsB = pedido('sala-fusca', '16:00', '17:00');
  const [a, b] = await Promise.all([
    enviar(agent, textoPedido(argsA), undefined, traceA),
    enviar(agent, textoPedido(argsB), undefined, traceB),
  ]);
  assert.equal(state(a), 'INPUT_REQUIRED'); assert.equal(state(b), 'INPUT_REQUIRED');
  const idA = a.result.task.id; const idB = b.result.task.id;
  const originalMessage = a.result.task.status.message.parts[0].text;
  const invalida = await enviar(agent, 'escolha=sala-aquario', idA);
  assert.equal(state(invalida), 'INPUT_REQUIRED');
  assert.equal(invalida.result.task.status.message.parts[0].text, originalMessage);
  // Continuacao omite traceparent: o trace original deve permanecer vinculado a Task.
  const finalB = await enviar(agent, 'escolha=sala-mirante', idB);
  const finalA = await enviar(agent, 'escolha=sala-fusca', idA);
  assert.equal(state(finalA), 'COMPLETED'); assert.equal(state(finalB), 'COMPLETED');
  assert.equal(artifact(finalA).inicio, argsA.inicio); assert.equal(artifact(finalB).inicio, argsB.inicio);
  assert.notEqual(artifact(finalA).reserva, artifact(finalB).reserva);
  assert.equal(artifact(finalA).politica, '2026-11-01');
  const get = await a2a(agent, 'GetTask', { id: idA });
  assert.deepEqual(get.result.task, finalA.result.task);
  assert.ok((await enviar(agent, 'escolha=recusar', idA)).error);
  for (const trace of [traceA, traceB]) {
    const taskRequests = requests.filter(r => r.body.params._meta.traceparent === trace);
    assert.deepEqual(taskRequests.map(r => r.body.method),
      ['server/discover', 'tools/list', 'resources/read', 'tools/call', 'tools/call']);
    const calls = taskRequests.filter(r => r.body.method === 'tools/call');
    assert.notEqual(calls[0].body.id, calls[1].body.id);
    assert.ok(calls[1].body.params.requestState);
    const key = Object.keys(calls[1].body.params.inputResponses)[0]; assert.ok(key);
    assert.equal(JSON.stringify([a, b, invalida, finalA, finalB, get]).includes(calls[1].body.params.requestState), false);
    assert.ok(logs.some(line => line.method === 'tools/call' && line.traceparent === trace));
    for (const { body, headers } of taskRequests) {
      assert.equal(body.params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
      assert.deepEqual(body.params._meta['io.modelcontextprotocol/clientCapabilities'], meta['io.modelcontextprotocol/clientCapabilities']);
      assert.equal(headers.get('mcp-protocol-version'), '2026-07-28');
      assert.equal(headers.get('mcp-method'), body.method);
      if (body.method === 'tools/call') assert.equal(headers.get('mcp-name'), body.params.name);
      if (body.method === 'resources/read') assert.equal(headers.get('mcp-name'), body.params.uri);
    }
  }
});

test('decline conclui CANCELED e erro de dominio fica no historico FAILED', async t => {
  const server = criarServidorMcp({ secret: secret(), log: () => {} });
  const url = await servir(t, server);
  const agent = criarAgente({ mcpUrl: `${url}/mcp` }); t.after(agent.close);
  const pausa = await enviar(agent, textoPedido(pedido()));
  const canceled = await enviar(agent, 'escolha=recusar', pausa.result.task.id);
  assert.equal(state(canceled), 'CANCELED'); assert.deepEqual(canceled.result.task.artifacts, []);
  assert.ok((await enviar(agent, 'escolha=sala-fusca', pausa.result.task.id)).error);
  const failed = await enviar(agent, textoPedido(pedido('sala-delorean')));
  assert.equal(state(failed), 'FAILED');
  assert.equal(failed.result.task.status.message.parts[0].text, 'Sala inexistente: sala-delorean');
  assert.ok(failed.result.task.history.some(m => m.parts[0].text === 'Sala inexistente: sala-delorean'));
  assert.ok((await enviar(agent, 'escolha=recusar', failed.result.task.id)).error);
});

test('GetTask observa WORKING durante I/O e nao admite duas continuacoes simultaneas', async t => {
  let liberar; const espera = new Promise(resolve => { liberar = resolve; });
  const tasks = criarTasks({ criarHost: () => ({ politica: '2026-11-01',
    descobrir: async () => {}, close: async () => {},
    reservar: async (_args, continuacao) => {
      if (!continuacao?.requestState) return {
        resultType: 'input_required', requestState: 'opaco-para-o-agente',
        inputRequests: { pergunta: { method: 'elicitation/create', params: { mode: 'form',
          requestedSchema: { properties: { sala: { const: 'sala-fusca' } } } } } },
      };
      await espera;
      return { structuredContent: { reservado: true, reserva: 'res-teste', sala: 'sala-fusca' } };
    },
  }) });
  t.after(tasks.close);
  const inicial = await tasks.send({ messageId: 'm1', role: 'ROLE_USER', parts: [{ text: textoPedido(pedido()) }] });
  const continuation = { messageId: 'm2', role: 'ROLE_USER', taskId: inicial.id, parts: [{ text: 'escolha=sala-fusca' }] };
  const pending = tasks.send(continuation);
  assert.equal(tasks.get(inicial.id).status.state, 'TASK_STATE_WORKING');
  await assert.rejects(tasks.send(continuation), /Task nao aceita continuacao/);
  liberar(); const complete = await pending;
  assert.equal(complete.status.state, 'TASK_STATE_COMPLETED');
  assert.ok(complete.history.some(m => m.parts[0].text === 'Pedido recebido'));
  assert.ok(complete.history.some(m => m.parts[0].text === 'Consultando o servidor MCP'));
});

test('SDK 2.3.1: callTool/outputSchema falha em pausa, request/manual permite a ponte', async t => {
  const server = criarServidorMcp({ secret: secret(), log: () => {} });
  const url = await servir(t, server);
  const host = new McpHost(`${url}/mcp`); t.after(() => host.close());
  await host.descobrir();
  await assert.rejects(host.client.callTool({ name: host.reservarTool.name, arguments: pedido() },
    { allowInputRequired: true, toolDefinition: host.reservarTool }),
  error => error.code === -32600 && /output schema but did not return structured content/.test(error.message));
  const pausa = await host.reservar(pedido());
  assert.equal(pausa.resultType, 'input_required');
  const result = await host.reservar(pedido(), {
    requestState: pausa.requestState, inputResponses: { [Object.keys(pausa.inputRequests)[0]]: { action: 'decline' } },
  });
  assert.equal(result.structuredContent.reservado, false);
});

test('requestState continua valido apos reiniciar o processo MCP; outra secret rejeita', async t => {
  const key = secret();
  async function start(keyValue) {
    const child = spawn(process.execPath, ['servidor-mcp/index.js'], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, MCP_PORT: '0', REQUEST_STATE_SECRET: keyValue },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let output = '';
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('MCP nao iniciou')); }, 10000);
      child.once('error', reject);
      child.once('exit', () => { clearTimeout(timer); reject(new Error('MCP encerrou antes de iniciar')); });
      child.stderr.on('data', b => {
        output += b; const match = /MCP (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(output);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const stop = async () => {
      if (child.exitCode !== null) return;
      const end = once(child, 'exit'); child.kill('SIGTERM'); await end;
    };
    t.after(stop);
    return { fetch: async request => fetch(url, { method: 'POST', headers: request.headers, body: await request.text() }), stop };
  }
  const first = await start(key);
  const args = pedido();
  const pausa = (await mcp(first, 'tools/call', { name: 'reservar_sala', arguments: args })).body.result;
  await first.stop();
  const second = await start(key);
  const completed = await mcp(second, 'tools/call', retry(args, pausa));
  assert.equal(completed.body.result.structuredContent.reservado, true);
  assert.equal(completed.body.result.structuredContent.sala, 'sala-fusca');
  await second.stop();
  const third = await start(secret());
  const rejected = await mcp(third, 'tools/call', retry(args, pausa));
  assert.equal(rejected.body.error.code, -32602);
});
