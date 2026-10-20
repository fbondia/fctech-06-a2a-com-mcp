import test from 'node:test';
import assert from 'node:assert/strict';
import { criarSalas, ERROS } from '../servidor-mcp/salas.js';
import { pedido, h } from './helpers.js';

test('politica aceita limites 08h/20h, 2h, passado e offsets equivalentes', () => {
  const salas = criarSalas();
  for (const p of [pedido('sala-aquario', '08:00', '10:00'), pedido('sala-aquario', '18:00', '20:00'),
    { sala: 'sala-aquario', inicio: '2001-01-01T11:00:00Z', fim: '2001-01-01T13:00:00Z' }]) {
    assert.equal(salas.consultar(p).livre, true);
  }
});

test('validacoes tem ordem e mensagens exatas nos dois caminhos de dominio', () => {
  const salas = criarSalas();
  for (const [args, erro] of [
    [pedido('sala-inexistente'), 'Sala inexistente: sala-inexistente'],
    [pedido('sala-aquario', '10:00', '10:00'), ERROS.intervalo],
    [pedido('sala-aquario', '10:00', '09:00'), ERROS.intervalo],
    [pedido('sala-aquario', '07:59', '08:30'), ERROS.janela],
    [pedido('sala-aquario', '19:00', '20:01'), ERROS.janela],
    [pedido('sala-aquario', '08:00', '10:01'), ERROS.duracao],
    [{ ...pedido(), fim: '2026-11-04T15:00:00-03:00' }, ERROS.janela],
  ]) for (const fn of [salas.consultar, salas.reservar]) assert.throws(() => fn(args), { message: erro });
});

test('sobreposicao e semiaberta e reservas criadas aparecem nas consultas', () => {
  const salas = criarSalas();
  assert.equal(salas.consultar(pedido()).conflitos[0].responsavel, 'Marty');
  assert.equal(salas.consultar(pedido('sala-garagem', '13:00', '14:00')).livre, true);
  assert.equal(salas.consultar(pedido('sala-garagem', '15:00', '16:00')).livre, true);
  const nova = salas.reservar(pedido('sala-aquario', '09:00', '10:00'));
  assert.equal(nova.reserva, 'res-0003');
  assert.equal(nova.politica, salas.versao);
  assert.equal(salas.consultar(pedido('sala-aquario', '09:30', '10:30')).livre, false);
  assert.equal(criarSalas().consultar(pedido('sala-aquario', '09:00', '10:00')).livre, true);
});

test('alternativas limitam a tres, ordenam capacidade/id e excluem ocupadas', () => {
  const salas = criarSalas();
  salas.reservar(pedido('sala-aquario', '10:00', '11:00'));
  const args = { ...pedido('sala-aquario'), inicio: h('10:00'), fim: h('11:00') };
  assert.deepEqual(salas.alternativas(args), ['sala-porao', 'sala-fusca', 'sala-garagem']);
  assert.deepEqual(salas.alternativas(pedido()), ['sala-fusca', 'sala-mirante']);
  salas.reservar(pedido('sala-mirante', '11:00', '12:00'));
  assert.deepEqual(salas.alternativas(pedido('sala-mirante', '11:00', '12:00')), []);
});
