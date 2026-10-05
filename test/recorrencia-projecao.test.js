'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/ledger-engine.js');

const rec = (s, o) => E.addRecurrence(s, Object.assign({ tipo: 'despesa', valor: 10000, descricao: 'Internet', inicio: '2026-09-10', categoria: 'Moradia' }, o)).recorrencia;

test('M5: recorrência mensal gera ocorrências até 90 dias à frente', () => {
  const s = E.freshState(); const r = rec(s, {});
  const n = E.materializeRecurrences(s, '2026-09-30');
  // 30/09 + 90 dias = 29/12 -> meses 09, 10, 11, 12
  assert.equal(n, 4);
  assert.deepEqual(s.expenses.map((e) => e.vencimento), ['2026-09-10', '2026-10-10', '2026-11-10', '2026-12-10']);
  assert.ok(s.expenses.every((e) => e.recorrenciaId === r.id && !e.pago));
  assert.deepEqual(s.expenses.map((e) => e.competencia), ['2026-09', '2026-10', '2026-11', '2026-12']);
});

test('M5: idempotente — rodar de novo não duplica', () => {
  const s = E.freshState(); rec(s, {});
  E.materializeRecurrences(s, '2026-09-30');
  assert.equal(E.materializeRecurrences(s, '2026-09-30'), 0);
  assert.equal(s.expenses.length, 4);
  assert.equal(E.materializeRecurrences(s, '2026-10-30'), 1);      // avançou o horizonte: só o mês novo
});

test('M5: dia 31 usa o último dia do mês e volta a 31 depois', () => {
  const s = E.freshState(); rec(s, { inicio: '2026-01-31' });
  E.materializeRecurrences(s, '2026-01-31');
  assert.deepEqual(s.expenses.map((e) => e.vencimento), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
});

test('M5: entrada recorrente (salário) gera entradas', () => {
  const s = E.freshState(); rec(s, { tipo: 'entrada', valor: 500000, descricao: 'Salário', inicio: '2026-10-05', categoria: 'Salário' });
  E.materializeRecurrences(s, '2026-09-30');
  assert.deepEqual(s.income.map((i) => [i.data, i.valor]), [['2026-10-05', 500000], ['2026-11-05', 500000], ['2026-12-05', 500000]]);
  assert.equal(s.expenses.length, 0);
});

test('M5: fim da recorrência, pausa e mês apagado não voltam', () => {
  const s = E.freshState(); const r = rec(s, { fim: '2026-11-15' });
  E.materializeRecurrences(s, '2026-09-30');
  assert.equal(s.expenses.length, 3);                               // set, out, nov (dez passa do fim)
  const oct = s.expenses.find((e) => e.competencia === '2026-10');
  assert.equal(E.deleteExpense(s, oct.id).ok, true);
  E.materializeRecurrences(s, '2026-09-30');
  assert.equal(s.expenses.length, 2);                               // outubro apagado não é recriado
  E.setRecurrenceActive(s, r.id, false);
  const s2 = E.freshState(); const r2 = rec(s2, {}); E.setRecurrenceActive(s2, r2.id, false);
  assert.equal(E.materializeRecurrences(s2, '2026-09-30'), 0);
});

test('M5: remover modelo apaga ocorrências futuras não pagas e mantém as passadas/pagas', () => {
  const s = E.freshState(); const r = rec(s, {});
  E.materializeRecurrences(s, '2026-09-30');
  E.payExpense(s, s.expenses[0].id, { data: '2026-09-10' }, '2026-09-30');
  E.removeRecurrence(s, r.id, '2026-09-30');
  assert.equal(s.recorrencias.length, 0);
  assert.deepEqual(s.expenses.map((e) => e.vencimento), ['2026-09-10']);
  assert.equal(s.expenses[0].recorrenciaId, '');
});

test('M5: valida entrada e sobrevive à normalização', () => {
  const s = E.freshState();
  assert.equal(E.addRecurrence(s, { valor: 0, descricao: 'x', inicio: '2026-01-01' }).ok, false);
  assert.equal(E.addRecurrence(s, { valor: 100, descricao: '', inicio: '2026-01-01' }).ok, false);
  assert.equal(E.addRecurrence(s, { valor: 100, descricao: 'x', inicio: 'ontem' }).ok, false);
  rec(s, {}); E.materializeRecurrences(s, '2026-09-30');
  const n = E.normalizeState(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(n.recorrencias, s.recorrencias);
  assert.equal(E.materializeRecurrences(n, '2026-09-30'), 0);
});

function base() {
  const s = E.freshState();
  Object.assign(s.card, { limite: 300000, fechamento: 25, vencimentoDia: 5 });
  return s;
}

test('M6: projeção 30/60/90 soma despesas em aberto, parcelas, faturas previstas e entradas esperadas', () => {
  const s = base();
  s.expenses.push(E.makeExpense({ valor: 20000, descricao: 'Atrasada', vencimento: '2026-09-20' }));
  s.expenses.push(E.makeExpense({ valor: 30000, descricao: 'Em 20 dias', vencimento: '2026-10-20' }));
  s.expenses.push(E.makeExpense({ valor: 70000, descricao: 'Em 50 dias', vencimento: '2026-11-19' }));
  s.debts.push({ id: 'd', valorParcela: 10000, descricao: 'Emp', parcelas: 4, parcelaAtual: 1, vencimento: '2026-10-05', diaOriginal: 5, pago: false, pagas: [], valorContratado: null, taxa: null, categoria: 'Dívidas' });
  E.addCardPurchase(s, { valor: 40000, descricao: 'TV', data: '2026-09-10' });          // fatura vence 05/10
  s.income.push(E.makeIncome({ valor: 90000, descricao: 'Freela', data: '2026-10-10' }));
  const [p30, p60, p90] = E.projectionAll(s, '2026-09-30');
  assert.equal(p30.ate, '2026-10-30');
  assert.deepEqual(p30.saidas, { despesas: 50000, dividas: 10000, cartao: 40000, total: 100000 });
  assert.equal(p30.entradas, 90000);
  assert.equal(p30.atrasadas, 20000);
  assert.equal(p30.resultado, 90000 - 100000);
  assert.equal(p30.saldoInicial, undefined);
  assert.equal(p60.saidas.despesas, 120000);
  assert.equal(p60.saidas.dividas, 20000);                        // parcelas de 05/10 e 05/11
  assert.equal(p90.saidas.dividas, 30000);                        // + 05/12
  assert.ok(p60.resultado < p30.resultado);
});

test('M6: projeção inclui recorrências e não altera o estado', () => {
  const s = base();
  rec(s, { valor: 10000, inicio: '2026-10-10' });
  const antes = JSON.stringify(s);
  const [p30, p60, p90] = E.projectionAll(s, '2026-09-30');
  assert.equal(p30.saidas.despesas, 10000);
  assert.equal(p60.saidas.despesas, 20000);
  assert.equal(p90.saidas.despesas, 30000);
  assert.equal(JSON.stringify(s), antes);
});

test('M6: despesas pagas não entram na projeção', () => {
  const s = E.freshState();
  s.expenses.push(E.makeExpense({ valor: 5000, descricao: 'Paga', vencimento: '2026-10-05' }));
  E.payExpense(s, s.expenses[0].id, { data: '2026-09-30' }, '2026-09-30');
  const p = E.projection(s, '2026-09-30', 30);
  assert.equal(p.saidas.total, 0);
  assert.equal(p.resultado, 0);
});
