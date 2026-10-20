import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Estado limpo a cada execucao: dois processos reais, encerrados inclusive em falha.
const env = { ...process.env, REQUEST_STATE_SECRET: process.env.REQUEST_STATE_SECRET ?? randomBytes(32).toString('hex') };
env.MCP_URL = `http://127.0.0.1:${env.MCP_PORT ?? 7301}/mcp`;
const logs = { mcp: '', agente: '' };
const children = [];
const directory = new URL('../docs/evidence/', import.meta.url);
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
async function start(name, script) {
  const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', b => { logs[name] += b; });
  child.stderr.on('data', b => { logs[name] += b; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout iniciando ${name}`)), 10000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`${name} saiu com ${code}: ${logs[name]}`)); });
    child.stderr.on('data', () => {
      if (logs[name].includes('http://')) { clearTimeout(timer); resolve(); }
    });
  });
}

try {
  await start('mcp', 'servidor-mcp/index.js');
  await start('agente', 'agente/index.js');
  const validator = spawn('python3', ['validador/validar.py', '--agente',
    `http://127.0.0.1:${env.AGENT_PORT ?? 7300}`, '--mcp', `http://127.0.0.1:${env.MCP_PORT ?? 7301}`],
  { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  validator.stdout.on('data', b => { output += b; process.stdout.write(b); });
  process.exitCode = await new Promise((resolve, reject) => {
    validator.once('error', reject); validator.once('exit', code => resolve(code ?? 1));
  });
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('validator.txt', directory), output);
  await writeFile(new URL('mcp-stderr.jsonl', directory), logs.mcp);
  await writeFile(new URL('agent-stderr.txt', directory), logs.agente);
} finally {
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve); child.kill('SIGTERM');
  })));
}
