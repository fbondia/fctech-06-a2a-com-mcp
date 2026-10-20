import { readFileSync } from 'node:fs';

export const ERROS = {
  janela: 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00',
  duracao: 'Duracao acima do limite: a politica permite no maximo 2 horas',
  intervalo: 'Intervalo invalido: fim deve ser posterior a inicio',
  alternativas: 'Sem alternativas disponiveis no intervalo',
};

const ler = nome => readFileSync(new URL(`../dados/${nome}`, import.meta.url), 'utf8');

// Apenas as reservas sao mutaveis. Cada processo parte dos dados do starter.
export function criarSalas() {
  const salas = JSON.parse(ler('salas.json'));
  const reservas = JSON.parse(ler('reservas.json'));
  const politica = ler('politica-de-uso.md');
  const versao = /^versao:\s*(\S+)/.exec(politica)?.[1];
  if (!versao) throw new Error('Politica sem versao');
  let sequencia = Math.max(...reservas.map(r => Number(r.id.slice(4))));

  function validar({ sala, inicio, fim }) {
    const encontrada = salas.find(s => s.id === sala);
    if (!encontrada) throw new Error(`Sala inexistente: ${sala}`);
    const de = Date.parse(inicio);
    const ate = Date.parse(fim);
    if (!Number.isFinite(de) || !Number.isFinite(ate) || ate <= de) {
      throw new Error(ERROS.intervalo);
    }
    // O contrato usa Sao Paulo com offset fixo -03:00, inclusive no passado.
    const localDe = new Date(de - 3 * 3600000);
    const localAte = new Date(ate - 3 * 3600000);
    const horaDe = localDe.getUTCHours() + localDe.getUTCMinutes() / 60
      + localDe.getUTCSeconds() / 3600 + localDe.getUTCMilliseconds() / 3600000;
    const horaAte = localAte.getUTCHours() + localAte.getUTCMinutes() / 60
      + localAte.getUTCSeconds() / 3600 + localAte.getUTCMilliseconds() / 3600000;
    if (localDe.toISOString().slice(0, 10) !== localAte.toISOString().slice(0, 10)
      || horaDe < 8 || horaDe >= 20 || horaAte > 20 || horaAte <= 8) {
      throw new Error(ERROS.janela);
    }
    if (ate - de > 2 * 3600000) throw new Error(ERROS.duracao);
    return encontrada;
  }

  function conflitos({ sala, inicio, fim }) {
    return reservas.filter(r => r.sala === sala
      && Date.parse(r.inicio) < Date.parse(fim) && Date.parse(r.fim) > Date.parse(inicio));
  }

  function consultar(pedido) {
    validar(pedido);
    const ocupacoes = conflitos(pedido);
    return { sala: pedido.sala, livre: ocupacoes.length === 0,
      conflitos: ocupacoes.map(({ id, inicio, fim, responsavel }) => ({ id, inicio, fim, responsavel })) };
  }

  function alternativas(pedido) {
    const original = validar(pedido);
    return salas.filter(s => s.capacidade >= original.capacidade
      && conflitos({ ...pedido, sala: s.id }).length === 0)
      .sort((a, b) => a.capacidade - b.capacidade || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, 3).map(s => s.id);
  }

  function reservar(pedido) {
    validar(pedido);
    if (conflitos(pedido).length) throw new Error('Sala ocupada no intervalo');
    const id = `res-${String(++sequencia).padStart(4, '0')}`;
    reservas.push({ id, ...pedido });
    return { reserva: id, reservado: true, ...pedido, politica: versao, motivo: null };
  }

  return { salas, politica, versao, validar, consultar, conflitos, alternativas, reservar };
}
