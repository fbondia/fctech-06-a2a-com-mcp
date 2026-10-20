import { randomUUID } from 'node:crypto';
import { McpHost } from './mcp-host.js';

const prefixo = 'TASK_STATE_';
const transicoes = {
  SUBMITTED: ['WORKING'], WORKING: ['INPUT_REQUIRED', 'COMPLETED', 'CANCELED', 'FAILED'],
  INPUT_REQUIRED: ['WORKING', 'INPUT_REQUIRED'], COMPLETED: [], CANCELED: [], FAILED: [],
};
export class ErroA2a extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function transitar(task, estado, texto) {
  const atual = task.status?.state?.slice(prefixo.length);
  if (atual && !transicoes[atual]?.includes(estado)) throw new Error(`Transicao invalida: ${atual} -> ${estado}`);
  const message = { messageId: randomUUID(), role: 'ROLE_AGENT', taskId: task.id,
    contextId: task.contextId, parts: [{ text: texto }] };
  task.status = { state: prefixo + estado, timestamp: new Date().toISOString(), message };
  task.history.push(message);
}

function pedidoDe(texto) {
  const match = /^reservar sala=(\S+) inicio=(\S+) fim=(\S+) responsavel=(.+)$/.exec(texto);
  if (!match) throw new ErroA2a(-32602, 'Use reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>');
  return { sala: match[1], inicio: match[2], fim: match[3], responsavel: match[4] };
}

export function criarTasks({ mcpUrl = 'http://127.0.0.1:7301/mcp',
  criarHost = trace => new McpHost(mcpUrl, trace) } = {}) {
  // Os objetos publicos nunca incluem o host, argumentos de retry ou requestState.
  const entries = new Map();
  const snapshot = entry => structuredClone(entry.task);
  function obter(id) {
    const entry = entries.get(id);
    if (!entry) throw new ErroA2a(-32001, 'Task inexistente');
    return entry;
  }

  async function aplicarResultado(entry, resultado) {
    const { task } = entry;
    if (resultado.resultType === 'input_required') {
      const pedidos = Object.entries(resultado.inputRequests ?? {});
      if (pedidos.length !== 1 || pedidos[0][1].method !== 'elicitation/create'
        || pedidos[0][1].params.mode !== 'form' || typeof resultado.requestState !== 'string') {
        throw new Error('Resposta MRTR inesperada');
      }
      const [chave, request] = pedidos[0];
      const campo = request.params.requestedSchema?.properties?.sala;
      const alternativas = campo?.enum ?? (campo?.const ? [campo.const] : []);
      if (!alternativas.length || !alternativas.every(s => typeof s === 'string')) {
        throw new Error('Elicitation sem alternativas');
      }
      entry.pausa = { chave, alternativas, requestState: resultado.requestState };
      transitar(task, 'INPUT_REQUIRED', `alternativas: ${alternativas.join(', ')}`);
      return;
    }
    if (resultado.isError) {
      const texto = (resultado.content ?? []).map(p => p.text ?? '').join(' ');
      transitar(task, 'FAILED', texto);
      return;
    }
    const dados = resultado.structuredContent;
    if (dados?.reservado === false) {
      transitar(task, 'CANCELED', dados.motivo ?? 'recusado');
    } else if (dados?.reservado === true && dados.reserva) {
      task.artifacts.push({ artifactId: randomUUID(), name: 'reserva',
        parts: [{ text: JSON.stringify({ ...dados, politica: entry.host.politica }) }] });
      transitar(task, 'COMPLETED', `Reserva ${dados.reserva} confirmada na ${dados.sala}.`);
    } else throw new Error('Resultado de reserva inesperado');
  }

  async function executar(entry, continuacao) {
    try {
      if (!entry.iniciado) {
        await entry.host.descobrir();
        entry.iniciado = true;
      }
      await aplicarResultado(entry, await entry.host.reservar(entry.pedido, continuacao));
    } catch (error) {
      // Erros de transporte/protocolo nao podem serializar o envelope privado do MCP.
      console.error(JSON.stringify({ taskId: entry.task.id, error: error.name, code: error.code ?? null }));
      transitar(entry.task, 'FAILED', 'Falha na comunicacao com o servidor MCP');
    } finally {
      if (entry.task.status.state !== prefixo + 'INPUT_REQUIRED') {
        delete entry.pausa;
        await entry.host.close().catch(() => {});
      }
    }
    return snapshot(entry);
  }

  return {
    get(id) { return snapshot(obter(id)); },
    async send(message, traceparent) {
      if (!message || message.role !== 'ROLE_USER' || typeof message.messageId !== 'string'
        || !Array.isArray(message.parts) || !message.parts.length
        || !message.parts.every(p => typeof p?.text === 'string')) {
        throw new ErroA2a(-32602, 'Mensagem de texto ROLE_USER invalida');
      }
      const texto = message.parts.map(p => p.text).join(' ');
      if (!message.taskId) {
        const pedido = pedidoDe(texto);
        const task = { id: randomUUID(), contextId: randomUUID(), history: [], artifacts: [] };
        const entry = { task, pedido, host: criarHost(traceparent) };
        entries.set(task.id, entry);
        task.history.push(structuredClone(message));
        transitar(task, 'SUBMITTED', 'Pedido recebido');
        transitar(task, 'WORKING', 'Consultando o servidor MCP');
        return executar(entry);
      }
      const entry = obter(message.taskId);
      if (entry.task.status.state !== prefixo + 'INPUT_REQUIRED') {
        throw new ErroA2a(-32602, 'Task nao aceita continuacao no estado corrente');
      }
      entry.task.history.push(structuredClone(message));
      const escolha = /^escolha=(\S+)$/.exec(texto)?.[1];
      const { chave, alternativas, requestState } = entry.pausa;
      if (escolha !== 'recusar' && !alternativas.includes(escolha)) {
        transitar(entry.task, 'INPUT_REQUIRED', `alternativas: ${alternativas.join(', ')}`);
        return snapshot(entry);
      }
      transitar(entry.task, 'WORKING', 'Retomando a reserva no servidor MCP');
      // Ponte de volta: mesmo estado opaco/chave, pedido original, novo request SDK.
      return executar(entry, { requestState, inputResponses: {
        [chave]: escolha === 'recusar' ? { action: 'decline' }
          : { action: 'accept', content: { sala: escolha } },
      } });
    },
    async close() { await Promise.all([...entries.values()].map(e => e.host.close().catch(() => {}))); },
  };
}
