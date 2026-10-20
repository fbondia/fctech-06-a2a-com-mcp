import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { McpHost } from '../agente/mcp-host.js';

// Dois processos reais; a chave aleatoria nunca e gravada nas evidencias.
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = new URL('../docs/evidence/', import.meta.url);
const mcpPort = process.env.MCP_PORT ?? '7301';
const agentPort = process.env.AGENT_PORT ?? '7300';
const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
const agentUrl = `http://127.0.0.1:${agentPort}`;
const env = { ...process.env, MCP_PORT: mcpPort, AGENT_PORT: agentPort,
  MCP_URL: mcpUrl, AGENT_URL: agentUrl,
  REQUEST_STATE_SECRET: randomBytes(32).toString('hex') };
const children = new Set();
const logs = { mcp: '', agente: '' };
const exchanges = [];
const checks = [];
const bridgeTrace = `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
let rpcId = 1000;

async function start(name, script) {
  const child = spawn(process.execPath, [script], { cwd: root, env,
    stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout iniciando ${name}`)), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`${name} encerrou: ${code}`)); });
    child.stdout.on('data', b => { logs[name] += b; });
    child.stderr.on('data', b => {
      logs[name] += b;
      if (b.toString().includes(name === 'mcp' ? 'MCP http://' : 'A2A http://')) {
        clearTimeout(timer); resolve();
      }
    });
  });
  return child;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit');
  child.kill('SIGTERM');
  await done;
  children.delete(child);
}

async function exchange(label, url, body, headers = {}) {
  const requestHeaders = { 'Content-Type': 'application/json', ...headers };
  const response = await fetch(url, { method: 'POST', headers: requestHeaders,
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const result = { httpStatus: response.status, body: await response.json() };
  exchanges.push({ label, request: { url, headers: requestHeaders, body }, response: result });
  return result;
}

async function a2a(label, method, params, traceparent) {
  return (await exchange(label, `${agentUrl}/a2a`, {
    jsonrpc: '2.0', id: ++rpcId, method, params,
  }, traceparent ? { traceparent } : {})).body;
}

const pedido = (sala = 'sala-garagem', inicio = '14:00', fim = '15:00') => ({ sala,
  inicio: `2026-11-03T${inicio}:00-03:00`, fim: `2026-11-03T${fim}:00-03:00`, responsavel: 'Doc' });
const texto = p => `reservar sala=${p.sala} inicio=${p.inicio} fim=${p.fim} responsavel=${p.responsavel}`;
async function send(label, text, taskId, traceparent) {
  return a2a(label, 'SendMessage', { message: { messageId: randomUUID(), role: 'ROLE_USER',
    parts: [{ text }], ...(taskId ? { taskId } : {}) } }, traceparent);
}
const state = rpc => rpc.result.task.status.state;
const artifact = rpc => JSON.parse(rpc.result.task.artifacts[0].parts[0].text);
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } } };
async function mcp(label, params, requestMeta = meta) {
  return exchange(label, mcpUrl, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call',
    params: { ...params, _meta: requestMeta } }, {
    Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': 'tools/call', 'Mcp-Name': 'reservar_sala',
  });
}
const initial = () => ({ name: 'reservar_sala', arguments: pedido() });
const retry = (paused, args = pedido(), action = 'accept') => ({ name: 'reservar_sala',
  arguments: args, requestState: paused.requestState, inputResponses: {
    [Object.keys(paused.inputRequests)[0]]: action === 'accept'
      ? { action, content: { sala: 'sala-fusca' } } : { action },
  } });
function pass(message) { checks.push({ status: 'PASS', message }); console.log(`PASS ${message}`); }

await mkdir(directory, { recursive: true });
let mcpChild;
try {
  mcpChild = await start('mcp', 'servidor-mcp/index.js');
  await start('agente', 'agente/index.js');
  const cardResponse = await fetch(`${agentUrl}/.well-known/agent-card.json`);
  assert.equal(cardResponse.status, 200);
  const card = await cardResponse.json();
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
  assert.ok(card.skills.some(skill => skill.id === 'reservar-sala'));
  await writeFile(new URL('agent-card.json', directory), JSON.stringify(card, null, 2) + '\n');
  pass('Agent Card HTTP 200, A2A 1.0 e skill reservar-sala');

  const paused = await send('a2a-pausa', texto(pedido()), undefined, bridgeTrace);
  assert.equal(state(paused), 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(paused.result.task.status.message.parts[0].text, 'alternativas: sala-fusca, sala-mirante');
  pass('Conflito pausa a Task com alternativas na ordem exigida');
  const taskId = paused.result.task.id;
  const invalid = await send('a2a-escolha-invalida', 'escolha=sala-aquario', taskId);
  assert.equal(state(invalid), 'TASK_STATE_INPUT_REQUIRED');
  pass('Escolha fora das alternativas preserva INPUT_REQUIRED');
  const complete = await send('a2a-retomada', 'escolha=sala-mirante', taskId);
  assert.equal(state(complete), 'TASK_STATE_COMPLETED');
  assert.equal(artifact(complete).sala, 'sala-mirante');
  assert.equal(artifact(complete).politica, '2026-11-01');
  const current = await a2a('a2a-get-task', 'GetTask', { id: taskId });
  assert.deepEqual(current.result.task, complete.result.task);
  pass('Retomada conclui na sala escolhida; GetTask preserva identidade e artifact com politica');
  const terminal = await send('a2a-estado-terminal', 'escolha=recusar', taskId);
  assert.ok(terminal.error);
  pass('Task terminal rejeita continuacao');

  const toCancel = await send('a2a-pausa-recusa', texto(pedido()));
  const canceled = await send('a2a-recusa', 'escolha=recusar', toCancel.result.task.id);
  assert.equal(state(canceled), 'TASK_STATE_CANCELED');
  pass('Recusa termina em CANCELED');
  const failed = await send('a2a-sala-inexistente', texto(pedido('sala-inexistente')));
  assert.equal(state(failed), 'TASK_STATE_FAILED');
  assert.ok(failed.result.task.history.some(message => message.parts.some(
    part => part.text === 'Sala inexistente: sala-inexistente')));
  pass('Sala inexistente termina em FAILED com a mensagem da tool no historico');

  const [a, b] = await Promise.all([
    send('a2a-paralela-a-pausa', texto(pedido())),
    send('a2a-paralela-b-pausa', texto(pedido('sala-fusca', '16:00', '17:00'))),
  ]);
  assert.equal(state(a), 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(state(b), 'TASK_STATE_INPUT_REQUIRED');
  const finalB = await send('a2a-paralela-b-retomada', 'escolha=sala-garagem', b.result.task.id);
  const finalA = await send('a2a-paralela-a-retomada', 'escolha=sala-fusca', a.result.task.id);
  assert.equal(state(finalA), 'TASK_STATE_COMPLETED');
  assert.equal(state(finalB), 'TASK_STATE_COMPLETED');
  assert.equal(artifact(finalA).inicio, pedido().inicio);
  assert.equal(artifact(finalB).inicio, pedido('sala-fusca', '16:00', '17:00').inicio);
  assert.notEqual(artifact(finalA).reserva, artifact(finalB).reserva);
  pass('Duas Tasks simultaneamente pausadas retomam sem trocar estado');
  const publicBodies = exchanges.filter(e => e.request.url.endsWith('/a2a')).map(e => e.response.body);
  assert.equal(JSON.stringify(publicBodies).includes('requestState'), false);
  pass('Nenhuma resposta A2A expoe requestState');

  const taskLogs = logs.mcp.split('\n').filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line)).filter(line => line.traceparent === bridgeTrace);
  assert.deepEqual(taskLogs.map(line => line.method), [
    'server/discover', 'tools/list', 'resources/read', 'tools/call', 'tools/call',
  ]);
  const calls = taskLogs.filter(line => line.method === 'tools/call');
  assert.notEqual(calls[0].id, calls[1].id);
  await writeFile(new URL('bridge-trace.json', directory), JSON.stringify({ traceparent: bridgeTrace,
    taskId, requests: taskLogs, initialRequestId: calls[0].id, retryRequestId: calls[1].id }, null, 2) + '\n');
  pass('Log comprova descoberta antes da chamada, trace original e id novo no retry');

  await stop(mcpChild);
  mcpChild = await start('mcp', 'servidor-mcp/index.js');
  const host = new McpHost(mcpUrl);
  try {
    await host.descobrir();
    let sdkError;
    try { await host.client.callTool({ name: 'reservar_sala', arguments: pedido() },
      { allowInputRequired: true, toolDefinition: host.reservarTool }); }
    catch (error) { sdkError = { code: error.code, message: error.message }; }
    assert.equal(sdkError?.code, -32600);
    assert.match(sdkError.message, /output schema but did not return structured content/);
    const raw = await host.reservar(pedido());
    assert.equal(raw.resultType, 'input_required');
    await writeFile(new URL('sdk-mrtr.json', directory), JSON.stringify({ sdkVersion: '2.3.1',
      callToolError: sdkError, requestWithAllowInputRequired: raw.resultType }, null, 2) + '\n');
    pass('Limitacao callTool/outputSchema reproduzida; request manual retorna input_required');
  } finally { await host.close(); }

  const noCapability = await mcp('mcp-sem-capability', initial(), {
    ...meta, 'io.modelcontextprotocol/clientCapabilities': {},
  });
  assert.equal(noCapability.httpStatus, 400);
  assert.equal(noCapability.body.error.code, -32021);
  assert.ok(noCapability.body.error.data.requiredCapabilities.elicitation.form);
  pass('Sem elicitation form: HTTP 400 e -32021 com requiredCapabilities');
  const p = (await mcp('mcp-pausa-integridade', initial())).body.result;
  assert.equal(p.resultType, 'input_required');
  const tampered = retry(p);
  tampered.requestState = p.requestState.slice(0, -6) + (p.requestState.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA');
  const rejected = await mcp('mcp-estado-adulterado', tampered);
  assert.equal(rejected.body.error.code, -32602);
  pass('requestState adulterado e rejeitado com -32602');
  const declined = await mcp('mcp-recusa', retry(p, pedido(), 'decline'));
  assert.equal(declined.body.result.isError, false);
  assert.equal(declined.body.result.structuredContent.reservado, false);
  pass('Decline MCP conclui sem reservar e sem isError');

  const pidBefore = mcpChild.pid;
  await stop(mcpChild);
  mcpChild = await start('mcp', 'servidor-mcp/index.js');
  assert.notEqual(mcpChild.pid, pidBefore);
  const resumed = await mcp('mcp-retry-apos-reinicio', retry(p, { ...pedido(), responsavel: 'Adulterado' }));
  assert.equal(resumed.body.result.resultType, 'complete');
  assert.equal(resumed.body.result.structuredContent.reservado, true);
  assert.equal(resumed.body.result.structuredContent.responsavel, 'Doc');
  assert.equal(resumed.body.result.structuredContent.sala, 'sala-fusca');
  await writeFile(new URL('mcp-restart.json', directory), JSON.stringify({ pidBefore, pidAfter: mcpChild.pid,
    sameSecret: true, secretPersistedToEvidence: false, originalRequestId: exchanges.find(
      e => e.label === 'mcp-pausa-integridade').request.body.id,
    retryRequestId: exchanges.at(-1).request.body.id, result: resumed.body.result.structuredContent }, null, 2) + '\n');
  pass('Estado valido retoma apos reinicio real do MCP; argumentos adulterados nao alteram o pedido selado');
} catch (error) {
  process.exitCode = 1;
  checks.push({ status: 'FAIL', message: error.message });
  console.error(error);
} finally {
  await Promise.all([...children].map(stop));
  await writeFile(new URL('manual-http.json', directory), JSON.stringify(exchanges, null, 2) + '\n');
  await writeFile(new URL('manual-mcp-stderr.txt', directory), logs.mcp);
  await writeFile(new URL('manual-agent-stderr.txt', directory), logs.agente);
  await writeFile(new URL('manual-summary.json', directory), JSON.stringify({
    completedAt: new Date().toISOString(), mcpUrl, agentUrl,
    passed: checks.filter(c => c.status === 'PASS').length,
    failed: checks.filter(c => c.status === 'FAIL').length, checks,
  }, null, 2) + '\n');
}
