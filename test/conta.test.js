'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/ledger-engine.js');

function setup() {
  const s = E.freshState();
  const { conta } = E.addAccount(s, { nome: 'Corrente', saldoInicial: 100000, dataSaldoInicial: '2026-09-01' });
  s.income.push(E.makeIncome({ id: 'i0', valor: 99999, descricao: 'Antes do saldo inicial', data: '2026-08-15' }));
  s.income.push(E.makeIncome({ id: 'i1', valor: 300000, descricao: 'Salário', data: '2026-09-05' }));
  s.income.push(E.makeIncome({ id: 'i2', valor: 50000, descricao: 'Futuro', data: '2026-10-05' }));
  s.expenses.push(E.makeExpense({ id: 'e1', valor: 80000, descricao: 'Aluguel', vencimento: '2026-09-10' }));
  s.expenses.push(E.makeExpense({ id: 'e2', valor: 20000, descricao: 'Em aberto', vencimento: '2026-09-20' }));
  E.payExpense(s, 'e1', { data: '2026-09-09', valorPago: 81000 }, '2026-09-30');
  return { s, conta };
}

test('A2: saldo atual = inicial + entradas realizadas − saídas realizadas (valor pago, não o previsto)', () => {
  const { s, conta } = setup();
  // 100000 + 300000 - 81000 ; ignora: entrada anterior ao saldo inicial, entrada futura e despesa em aberto
  assert.equal(E.saldoConta(s, conta.id, '2026-09-30'), 319000);
  assert.equal(E.saldoAtual(s, '2026-09-30'), 319000);
  assert.equal(E.saldoAtual(s, '2026-10-05'), 369000);          // a entrada futura passa a contar quando chega o dia
});

test('A2: sem conta cadastrada não há saldo atual', () => {
  assert.equal(E.saldoAtual(E.freshState(), '2026-09-30'), null);
});

test('A2: a conta exige data do saldo inicial válida; saldo pode ser negativo', () => {
  const s = E.freshState();
  assert.equal(E.addAccount(s, { nome: 'x', saldoInicial: 0, dataSaldoInicial: '' }).ok, false);
  const r = E.addAccount(s, { nome: 'Cheque', saldoInicial: -5000, dataSaldoInicial: '2026-01-01' });
  assert.equal(E.saldoConta(s, r.conta.id, '2026-09-30'), -5000);
});

test('A2: duas contas separam movimentos; item sem conta vai para a primeira', () => {
  const { s, conta } = setup();
  const b = E.addAccount(s, { nome: 'Poupança', saldoInicial: 1000, dataSaldoInicial: '2026-09-01' }).conta;
  s.income.push(E.makeIncome({ valor: 500, descricao: 'Rendimento', data: '2026-09-10', contaId: b.id }));
  assert.equal(E.saldoConta(s, b.id, '2026-09-30'), 1500);
  assert.equal(E.saldoConta(s, conta.id, '2026-09-30'), 319000);
  assert.equal(E.saldoAtual(s, '2026-09-30'), 320500);
  E.removeAccount(s, b.id);                                     // movimentos da conta removida passam para a primeira conta
  assert.equal(E.saldoAtual(s, '2026-09-30'), 319500);
});

test('A2: conciliação — saldo do banco igual ao do app', () => {
  const { s, conta } = setup();
  const r = E.reconcile(s, conta.id, 319000, '2026-09-30');
  assert.equal(r.status, 'ok');
  assert.equal(r.diferenca, 0);
});

test('A2: conciliação — diferença explicada por lançamentos ainda não conferidos', () => {
  const { s, conta } = setup();
  // o banco ainda não compensou o pagamento do aluguel (81000): banco = 400000
  E.setConferido(s, 'entrada', 'i1', true);
  const r = E.reconcile(s, conta.id, 400000, '2026-09-30');
  assert.equal(r.status, 'pendentes');
  assert.equal(r.diferenca, 81000);
  assert.deepEqual(r.pendentes, { qtd: 1, liquido: -81000 });
  assert.equal(r.saldoConciliado, 400000);
});

test('A2: conciliação — divergência que os pendentes não explicam', () => {
  const { s, conta } = setup();
  const r = E.reconcile(s, conta.id, 123456, '2026-09-30');
  assert.equal(r.status, 'divergente');
  assert.equal(r.diferenca, 123456 - 319000);
  assert.equal(E.reconcile(s, 'x', 0, '2026-09-30').ok, false);
});

test('A2: conferir só vale para entradas e despesas pagas; estorno limpa a conferência', () => {
  const { s } = setup();
  assert.equal(E.setConferido(s, 'saida', 'e2', true), false);          // em aberto
  assert.equal(E.setConferido(s, 'saida', 'e1', true), true);
  assert.equal(s.expenses[0].conferido, true);
  E.unpayExpense(s, 'e1');
  assert.equal(s.expenses[0].conferido, false);
});

test('A2: movimentos realizados vêm com sinal e do mais recente ao mais antigo', () => {
  const { s } = setup();
  const m = E.realizedMovements(s, '2026-09-30');
  assert.deepEqual(m.map((x) => [x.id, x.valor]), [['e1', -81000], ['i1', 300000]]);
});

test('A2: normalizeState preserva contas, conferência e conciliação', () => {
  const { s, conta } = setup();
  s.reconciliacao[conta.id] = { saldoBanco: 319000, data: '2026-09-30' };
  E.setConferido(s, 'entrada', 'i1', true);
  const n = E.normalizeState(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(n.contas, s.contas);
  assert.deepEqual(n.reconciliacao, s.reconciliacao);
  assert.equal(n.income.find((x) => x.id === 'i1').conferido, true);
});
