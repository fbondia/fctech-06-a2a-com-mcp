import { randomUUID } from 'node:crypto';
import { McpServer, createMcpHandler, createRequestStateCodec,
  inputRequired, inputResponse, ProtocolError } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { criarSalas, ERROS } from './salas.js';

const VERSION = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const intervalo = z.object({ sala: z.string(), inicio: z.iso.datetime({ offset: true }),
  fim: z.iso.datetime({ offset: true }) });
const pedidoSchema = intervalo.extend({ responsavel: z.string().min(1) });
const salaSchema = z.object({ id: z.string(), nome: z.string(), capacidade: z.number().int(),
  recursos: z.array(z.string()) });
const conflitoSchema = z.object({ id: z.string(), inicio: z.string(), fim: z.string(), responsavel: z.string() });
const completo = structuredContent => ({ resultType: 'complete', isError: false,
  content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent });
const erroTool = error => ({ resultType: 'complete', isError: true,
  content: [{ type: 'text', text: error.message }], structuredContent: { erro: error.message } });
const tentar = fn => { try { return completo(fn()); } catch (e) { return erroTool(e); } };
const erroRpc = (id, code, message) => Response.json({ jsonrpc: '2.0', id: id ?? null,
  error: { code, message } }, { status: 400 });

export function criarCodec(secret, ttlSeconds = 600) {
  if (!/^[a-f\d]{64,}$/i.test(secret ?? '') || secret.length % 2 !== 0) {
    throw new Error('REQUEST_STATE_SECRET deve conter pelo menos 32 bytes em hexadecimal; gere com secrets.token_hex(32)');
  }
  return createRequestStateCodec({ key: Buffer.from(secret, 'hex'), ttlSeconds,
    bind: ctx => `${ctx.mcpReq.method}\0reservar_sala` });
}

export function criarServidorMcp({ secret = process.env.REQUEST_STATE_SECRET,
  log = linha => console.error(linha), codec = criarCodec(secret) } = {}) {
  const dominio = criarSalas();
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'central-de-salas', version: '1.0.0' }, {
      capabilities: { tools: {}, resources: {} }, requestState: { verify: codec.verify },
    });
    server.registerResource('politica-de-uso', 'politica://uso', { mimeType: 'text/markdown' },
      uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: dominio.politica }] }));
    server.registerTool('listar_salas', {
      description: 'Lista todas as salas com capacidade e recursos.', inputSchema: z.object({}),
      outputSchema: z.object({ salas: z.array(salaSchema) }),
    }, () => completo({ salas: dominio.salas }));
    server.registerTool('consultar_disponibilidade', {
      description: 'Diz se uma sala esta livre no intervalo, e quais reservas conflitam.',
      inputSchema: intervalo,
      outputSchema: z.object({ sala: z.string(), livre: z.boolean(), conflitos: z.array(conflitoSchema) }),
    }, pedido => tentar(() => dominio.consultar(pedido)));
    server.registerTool('reservar_sala', {
      description: 'Reserva uma sala; em conflito, pede a escolha de uma alternativa.',
      inputSchema: pedidoSchema,
      outputSchema: z.object({ reserva: z.string().nullable(), reservado: z.boolean(),
        sala: z.string().nullable(), inicio: z.string().nullable(), fim: z.string().nullable(),
        responsavel: z.string().nullable(), politica: z.string().nullable(), motivo: z.string().nullable() }),
    }, async (argumentos, ctx) => {
      const selado = ctx.mcpReq.requestState();
      if (selado !== undefined) {
        if (selado.tool !== 'reservar_sala') throw new ProtocolError(-32602, 'Estado de outra tool');
        const resposta = inputResponse(ctx.mcpReq.inputResponses, selado.chave);
        if (resposta.kind !== 'elicit') throw new ProtocolError(-32602, 'Resposta de elicitation ausente');
        if (resposta.action === 'decline' || resposta.action === 'cancel') {
          return completo({ reserva: null, reservado: false, sala: null, inicio: null, fim: null,
            responsavel: null, politica: null, motivo: 'recusado' });
        }
        const sala = resposta.content?.sala;
        if (!selado.alternativas.includes(sala)) throw new ProtocolError(-32602, 'Escolha fora das alternativas');
        // Nunca usar argumentos reenviados: somente o pedido cuja integridade foi verificada.
        return tentar(() => dominio.reservar({ ...selado.pedido, sala }));
      }
      if (ctx.mcpReq.inputResponses) throw new ProtocolError(-32602, 'inputResponses exige requestState');
      try { dominio.validar(argumentos); } catch (e) { return erroTool(e); }
      if (!dominio.conflitos(argumentos).length) return tentar(() => dominio.reservar(argumentos));
      const alternativas = dominio.alternativas(argumentos);
      if (!alternativas.length) return erroTool(new Error(ERROS.alternativas));
      const chave = randomUUID();
      return inputRequired({
        inputRequests: { [chave]: inputRequired.elicit({
          message: 'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.',
          requestedSchema: { type: 'object', properties: { sala: { type: 'string', enum: alternativas } }, required: ['sala'] },
        }) },
        requestState: await codec.mint({ tool: 'reservar_sala', pedido: argumentos, alternativas, chave }, ctx),
      });
    });
    return server;
  }, { legacy: 'reject' });

  return {
    close: handler.close,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      let body;
      try { body = await request.json(); } catch { return erroRpc(null, -32700, 'Parse error'); }
      log(JSON.stringify({ method: body?.method ?? null, id: body?.id ?? null,
        traceparent: body?.params?._meta?.traceparent ?? null }));
      const meta = body?.params?._meta;
      // A entrada estrita nao aceita fallback para initialize/session do MCP antigo.
      if (!meta || typeof meta[VERSION] !== 'string' || !meta[CAPABILITIES]
        || typeof meta[CAPABILITIES] !== 'object' || Array.isArray(meta[CAPABILITIES])) {
        return erroRpc(body?.id, -32602, 'protocolVersion e clientCapabilities sao obrigatorios em _meta');
      }
      if (body.params.requestState !== undefined && (body.method !== 'tools/call'
        || body.params.name !== 'reservar_sala')) {
        return erroRpc(body.id, -32602, 'requestState pertence a reservar_sala');
      }
      return handler.fetch(request, { parsedBody: body });
    },
  };
}
