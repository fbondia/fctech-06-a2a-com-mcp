import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Um cliente por Task permite manter o trace original tambem nas continuacoes.
// A conexao HTTP e reutilizavel, mas nao carrega sessao de protocolo.
export class McpHost {
  constructor(url, traceparent) {
    this.traceparent = traceparent;
    this.client = new Client({ name: 'agente-central-de-salas', version: '1.0.0' }, {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
      inputRequired: { autoFulfill: false },
    });
    this.transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: async (input, init) => {
        if (!init?.body || !this.traceparent) return fetch(input, init);
        const body = JSON.parse(init.body);
        body.params ??= {};
        body.params._meta = { ...body.params._meta, traceparent: this.traceparent };
        return fetch(input, { ...init, body: JSON.stringify(body) });
      },
    });
  }

  async descobrir() {
    await this.client.connect(this.transport);
    const { tools } = await this.client.listTools({}, { cacheMode: 'refresh' });
    // O nome e a intencao da aplicacao; definicao e schemas vem da descoberta.
    this.reservarTool = tools.find(tool => tool.name === 'reservar_sala');
    if (!this.reservarTool) throw new Error('MCP nao oferece reservar_sala');
    const { contents } = await this.client.readResource({ uri: 'politica://uso' }, { cacheMode: 'refresh' });
    const texto = contents.find(c => c.uri === 'politica://uso')?.text;
    this.politica = /^versao:\s*(\S+)/.exec(texto ?? '')?.[1];
    if (!this.politica) throw new Error('Resource de politica sem versao');
  }

  reservar(argumentos, continuacao = {}) {
    // callTool() 2.3.1 valida outputSchema mesmo em input_required, que nao
    // possui structuredContent. request() e a API oficial para MRTR manual.
    return this.client.request({ method: 'tools/call', params: {
      name: this.reservarTool.name, arguments: argumentos, ...continuacao,
    } }, { allowInputRequired: true });
  }

  close() { return this.client.close(); }
}
