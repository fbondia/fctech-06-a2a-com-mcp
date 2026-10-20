# A Ponte: um agente A2A com MCP por dentro

Central de reservas de salas da Hill Valley Tech, com agente determinístico A2A
1.0 e servidor MCP em processos separados. Quando há conflito, a Task pausa até
o cliente escolher uma alternativa ou recusar. Não há LLM no caminho de execução.

## Como rodar

### Requisitos e instalação

- Node.js 20 ou superior e npm.
- Python 3.10 ou superior, sem dependências externas para o validador.
- Portas locais 7300 e 7301 disponíveis para os comandos padrão.

```bash
git clone https://github.com/fbondia/fctech-06-a2a-com-mcp.git
cd fctech-06-a2a-com-mcp
npm ci
```

As versões estão fixadas no `package.json` e no `package-lock.json`: SDKs oficiais
`@modelcontextprotocol/server` e `@modelcontextprotocol/client` 2.3.1,
`@hono/node-server` 2.1.5 e Zod 4.6.7. A aplicação usa ESM, MCP na revisão
2026-07-28 e A2A 1.0 com JSON-RPC 2.0 sobre HTTP.

### Terminal 1: servidor MCP

Na raiz do clone, gere uma chave aleatória de 32 bytes em hexadecimal:

```bash
export REQUEST_STATE_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
npm run start:mcp
```

Endpoint Streamable HTTP: `http://127.0.0.1:7301/mcp`. O stderr registra método,
id e `traceparent` dos requests.

Para testar uma continuação após reiniciar o MCP, mantenha a mesma chave: no
mesmo terminal, encerre com Ctrl+C e execute novamente apenas `npm run start:mcp`.
Não gere outra chave entre a pausa e o retry. O estado vale por dez minutos.
A chave deve permanecer privada; publique somente o comando de geração.

### Terminal 2: agente A2A

Na raiz do mesmo clone:

```bash
npm run start:agente
```

- JSON-RPC: `http://127.0.0.1:7300/a2a`, métodos `SendMessage` e `GetTask`.
- Agent Card: `http://127.0.0.1:7300/.well-known/agent-card.json`.
- Skill: `reservar-sala`.

### Terminal 3: conferir o card e executar o validador

```bash
curl --fail --silent --show-error \
  http://127.0.0.1:7300/.well-known/agent-card.json \
  | python3 -m json.tool

python3 validador/validar.py \
  --agente http://127.0.0.1:7300 \
  --mcp http://127.0.0.1:7301
```

O resultado esperado é `36 passaram, 0 falharam`, com código de saída 0.
Antes de cada nova execução do validador, encerre e reinicie os dois processos:
as reservas criadas numa rodada permanecem em memória e interferem na próxima.

### Configuração

| Variável | Padrão ou finalidade |
| --- | --- |
| `REQUEST_STATE_SECRET` | Obrigatória no MCP; pelo menos 32 bytes em hexadecimal, ou 64 caracteres hexadecimais |
| `MCP_PORT` | `7301` |
| `AGENT_PORT` | `7300` |
| `MCP_URL` | `http://127.0.0.1:7301/mcp`, endereço usado pelo agente |
| `AGENT_URL` | `http://127.0.0.1:<AGENT_PORT>`, base publicada no Agent Card |

Os processos escutam em `127.0.0.1`. A aplicação lê variáveis do ambiente e não
carrega `.env` automaticamente. Se mudar a porta do MCP na execução manual,
configure também `MCP_URL` no terminal do agente.

### Formato das mensagens

```text
reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty
```

Em uma execução recém-iniciada, esse pedido retorna `TASK_STATE_INPUT_REQUIRED`
com `alternativas: sala-fusca, sala-mirante`. A continuação é um novo
`SendMessage` com `message.taskId` igual ao id recebido e texto
`escolha=sala-mirante` ou `escolha=recusar`. O resultado é, respectivamente,
`TASK_STATE_COMPLETED` com artifact `reserva`, ou `TASK_STATE_CANCELED`.
Uma escolha inválida mantém a Task pausada.

Os corpos completos estão em [`exemplos/wire/`](exemplos/wire/). Substitua os ids
ilustrativos pelos retornados pela sua execução e envie somente o objeto
`request.body` como corpo HTTP.

### Testes e reprodução das evidências

```bash
npm test
```

São 15 testes de domínio, protocolo e integração, incluindo expiração,
adulteração, isolamento entre Tasks, trace e reinício real do processo MCP.

Com as portas escolhidas livres, os comandos abaixo iniciam e encerram seus
próprios processos, com estado inicial limpo. Não precisam dos terminais de
execução manual. A chave de assinatura é gerada em memória quando necessário.

```bash
mkdir -p docs/evidence
set -o pipefail

npm test 2>&1 | tee docs/evidence/tests.txt

MCP_PORT=17301 AGENT_PORT=17300 npm run verify \
  2>&1 | tee docs/evidence/verify.txt

MCP_PORT=17301 AGENT_PORT=17300 node scripts/evidence.js \
  2>&1 | tee docs/evidence/manual.txt
```

`scripts/validate.js`, executado por `npm run verify`, sobe os dois processos,
roda o validador oficial e salva sua saída e o stderr dos servidores.
`scripts/evidence.js` realiza chamadas HTTP adicionais, registra requests e
respostas e verifica os resultados, incluindo reiniciar o MCP mantendo a chave.
Ambos usam 7300/7301 quando as variáveis de porta não são fornecidas.

As evidências usam `.txt`, `.json` e `.jsonl`, pois `*.log` é ignorado pelo projeto.
Os comandos atualizam os arquivos de execução. Ao publicar uma nova rodada,
atualize também o bloco de saída abaixo e os registros de ambiente e integridade.

## Onde a ponte acontece

Em [`agente/tasks.js`](agente/tasks.js), `aplicarResultado` reconhece
`resultType: input_required`, guarda a chave de elicitation, as alternativas e o
`requestState` em `entry.pausa`, e chama `transitar` para publicar
`TASK_STATE_INPUT_REQUIRED`. Na continuação de `send`, a escolha é convertida em
`inputResponses`, usando a mesma chave recebida, e `executar` reenvia o pedido
original com o `requestState` opaco. Em [`agente/mcp-host.js`](agente/mcp-host.js),
`McpHost.reservar` faz um novo `client.request` de `tools/call`; o SDK atribui um
id novo ao retry. O agente guarda e ecoa o estado, sem abrir ou reconstruir seu
conteúdo.

No servidor, [`servidor-mcp/server.js`](servidor-mcp/server.js) cria a resposta
MRTR com `inputRequired` e assina o contexto com `codec.mint`. No retry, o codec
verifica integridade e expiração antes de disponibilizar o pedido selado à tool.
A reserva usa esse pedido e a alternativa aceita, não os argumentos reenviados.

A captura em [`bridge-trace.json`](docs/evidence/bridge-trace.json) mostra uma
Task passando por descoberta, leitura da política, chamada inicial com id `2`
e retry com id `3`, todos com o mesmo `traceparent`.

## Decisões técnicas

### Responsabilidades e estado

- **MCP:** oferece `listar_salas`, `consultar_disponibilidade`, `reservar_sala` e
  o resource `politica://uso`. Política, conflitos e alternativas ficam em
  [`servidor-mcp/salas.js`](servidor-mcp/salas.js).
- **Agente:** interpreta o formato fixo e traduz os protocolos. Usa o cliente
  oficial MCP por HTTP, descobre as tools e lê a versão da política no resource
  para incluí-la no artifact.
- **Tasks:** um `Map` privado, indexado pelo id, mantém pedido, cliente MCP e
  pausa por Task. As respostas públicas contêm apenas um snapshot da Task.
  Reiniciar o agente perde as Tasks; não há persistência em disco.
- **Reservas:** ficam em memória no MCP, inicializadas pelos JSON do starter.
  Um restart restaura as reservas iniciais.
- **Protocolo:** versão e capabilities viajam em cada request. O cliente mantido
  por Task não representa sessão de protocolo. O agente declara elicitation em
  form mode e desativa o preenchimento automático de `input_required`.
- **Trace:** o agente mantém o `traceparent` da abertura da Task e o propaga no
  `_meta` das chamadas MCP, inclusive na continuação. O MCP registra método, id
  e trace no stderr, sem registrar o `requestState`.

### Proteção do requestState

`criarCodec` usa `createRequestStateCodec` do SDK oficial, com HMAC-SHA256,
chave aleatória de no mínimo 32 bytes de `REQUEST_STATE_SECRET`, validade de
600 segundos e vínculo ao método `tools/call` e à tool `reservar_sala`.
O conteúdo assinado inclui pedido original, alternativas e chave da elicitation.
O conteúdo não é cifrado e deve ser tratado como opaco pelo agente.

O MCP não mantém um mapa de continuações: o estado assinado permite reconstruir
o pedido após reiniciar o servidor, desde que a chave seja a mesma e o token
não tenha expirado. Estados adulterados ou expirados recebem `-32602`.
Argumentos reenviados não substituem os valores selados. `decline` e `cancel`
concluem sem reserva e sem erro de execução.

### Tratamento de erros

Falhas de domínio retornam `resultType: complete` com `isError: true`; o agente
publica `TASK_STATE_FAILED` com a mensagem da tool no histórico. Recusa retorna
`reservado: false` e termina em `TASK_STATE_CANCELED`. Erros de protocolo são
JSON-RPC, incluindo ausência de metadados (`-32602`, HTTP 400) e falta de
elicitation em form mode (`-32021`, HTTP 400).

### Particularidade do SDK 2.3.1

Com `allowInputRequired: true` e a definição da tool, `client.callTool` valida
`outputSchema` mesmo em uma pausa que não contém `structuredContent`, emitindo:

```text
Tool reservar_sala has an output schema but did not return structured content
```

A implementação usa a API oficial
`client.request(..., { allowInputRequired: true })` para receber a pausa e
repassá-la ao cliente A2A. A reprodução está em
[`sdk-mrtr.json`](docs/evidence/sdk-mrtr.json) e no teste correspondente em
[`tests/integration.test.js`](tests/integration.test.js).

## Saída do validador

Execução de 20/10/2026, registrada em `America/Sao_Paulo`, a partir de uma cópia
temporária dos arquivos da entrega, sem `node_modules`, instalada com `npm ci`.
Ambiente: Node.js v24.12.0, npm 11.6.2 e Python 3.14.7. Foram usadas as portas
alternativas 17300/17301 para preservar os processos abertos nas portas padrão.
Cada rodada iniciou seus próprios processos do zero e os encerrou ao terminar.

- Testes da implementação: **15 passaram, 0 falharam**.
- Validador oficial: **36 passaram, 0 falharam**.
- Verificações HTTP complementares: **15 passaram, 0 falharam**.
- Todos os três comandos terminaram com código de saída **0**.

```text
trace-id desta execucao: 53af249dfd674437f5fb8b3b2af01b3f
procure esse valor no stderr do servidor MCP para conferir a propagacao do traceparent.

PASS 01 tools/list traz as tres tools
PASS 02 toda tool tem inputSchema de objeto
PASS 03 listar_salas devolve structuredContent e o mesmo JSON em texto
PASS 04 _meta sem protocolVersion devolve -32602 e HTTP 400
PASS 05 _meta sem clientCapabilities devolve -32602 e HTTP 400
PASS 06 tool inexistente e recusada, por -32602 ou por isError
PASS 07 resources/read de politica://uso devolve a politica
PASS 08 resources/read de URI inexistente devolve -32602
PASS 09 sala inexistente devolve isError com a mensagem exata
PASS 10 fora da janela devolve isError com a mensagem exata
PASS 11 duracao acima de 2h devolve isError com a mensagem exata
PASS 12 intervalo invertido devolve isError com a mensagem exata
PASS 13 conflito devolve input_required com inputRequests e requestState
PASS 14 a elicitation e form mode e oferece as alternativas na ordem certa
PASS 15 conflito sem a capability elicitation devolve -32021 e HTTP 400
PASS 16 retry com inputResponses e requestState conclui a reserva
PASS 17 requestState adulterado e rejeitado com -32602
PASS 18 argumentos adulterados no retry nao tomam efeito
PASS 19 recusa conclui sem reservar e sem isError
PASS 20 conflito sem alternativa possivel devolve isError com a mensagem exata

PASS 21 agent card responde 200 no well-known com JSON
PASS 22 o card declara a interface JSON-RPC com url e versao 1.0
PASS 23 o card declara a skill reservar-sala
PASS 24 SendMessage com sala livre conclui a Task
PASS 25 o artifact chama reserva e traz a versao da politica
PASS 26 GetTask devolve id, contextId e estado corrente
PASS 27 SendMessage com sala ocupada pausa a Task
PASS 28 a Task pausada lista as alternativas na ordem certa
PASS 29 escolha fora do enum mantem a Task pausada
PASS 30 a continuacao conclui a Task na sala escolhida
PASS 31 SendMessage em Task terminal e recusado
PASS 32 a recusa termina a Task em CANCELED
PASS 33 duas Tasks pausadas ao mesmo tempo concluem cada uma com a sua reserva
PASS 34 nenhuma resposta A2A carrega o requestState
PASS 35 sala inexistente termina a Task em FAILED com a mensagem da tool
PASS 36 o agente e deterministico: o mesmo pedido produz a mesma pausa

resumo: 36 passaram, 0 falharam, de 36 verificacoes
```

### Arquivos de evidência

| Evidência | Arquivo |
| --- | --- |
| Instalação limpa | [`install.txt`](docs/evidence/install.txt) |
| Testes da implementação | [`tests.txt`](docs/evidence/tests.txt) |
| Saída integral do validador | [`validator.txt`](docs/evidence/validator.txt) |
| Saída do comando de validação | [`verify.txt`](docs/evidence/verify.txt) |
| stderr do MCP durante o validador | [`mcp-stderr.jsonl`](docs/evidence/mcp-stderr.jsonl) |
| stderr do agente durante o validador | [`agent-stderr.txt`](docs/evidence/agent-stderr.txt) |
| Trace-id do validador correlacionado ao MCP | [`validator-trace.json`](docs/evidence/validator-trace.json) |
| Agent Card recebido por HTTP | [`agent-card.json`](docs/evidence/agent-card.json) |
| Requests e respostas HTTP complementares | [`manual-http.json`](docs/evidence/manual-http.json) |
| Verificações complementares | [`manual-summary.json`](docs/evidence/manual-summary.json) e [`manual.txt`](docs/evidence/manual.txt) |
| Logs da rodada complementar | [`manual-mcp-stderr.txt`](docs/evidence/manual-mcp-stderr.txt) e [`manual-agent-stderr.txt`](docs/evidence/manual-agent-stderr.txt) |
| Task, trace e ids da pausa/retomada | [`bridge-trace.json`](docs/evidence/bridge-trace.json) |
| Reinício do MCP e retomada com pedido selado | [`mcp-restart.json`](docs/evidence/mcp-restart.json) |
| Reprodução da particularidade do SDK | [`sdk-mrtr.json`](docs/evidence/sdk-mrtr.json) |
| Ambiente, horários e códigos de saída | [`run.json`](docs/evidence/run.json) |
| Commit de origem e estado inicial do checkout | [`source.json`](docs/evidence/source.json) |
| Integridade dos arquivos protegidos | [`protected-files.json`](docs/evidence/protected-files.json) |

Em `manual-http.json`, os rótulos `a2a-pausa`, `a2a-retomada`, `a2a-get-task`,
`a2a-recusa` e `a2a-sala-inexistente` identificam os principais cenários A2A.
Os rótulos `mcp-estado-adulterado`, `mcp-sem-capability` e
`mcp-retry-apos-reinicio` identificam verificações diretas do servidor.
Os tokens de estado capturados são temporários e não incluem a chave de assinatura;
para reproduzir o fluxo, obtenha tokens novos numa nova execução.

Os 16 arquivos de `dados/`, `validador/` e `exemplos/` foram comparados com o
commit inicial do starter e permanecem idênticos. A documentação e as evidências
não exigem alterações nesses diretórios.
