'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/ledger-engine.js');

function base(extra) { return Object.assign(E.freshState(), extra || {}); }
function divida(o) {
  return Object.assign({ id: 'd1', valorParcela: 10000, descricao: 'Empréstimo', parcelas: 3, parcelaAtual: 1, vencimento: '2026-01-31', diaOriginal: 31, pago: false, pagas: [], valorContratado: null, taxa: null, categoria: 'Dívidas' }, o || {});
}

test('A5: parcela de 31/01 vence 28/02 e volta a 31/03 (não 03/03)', () => {
  const s = base({ debts: [divida()] });
  const r1 = E.payDebtInstallment(s, 'd1', { data: '2026-01-31' }, '2026-01-31');
  assert.ok(r1.ok);
  assert.equal(s.debts[0].vencimento, '2026-02-28');
  E.payDebtInstallment(s, 'd1', { data: '2026-02-28' }, '2026-02-28');
  assert.equal(s.debts[0].vencimento, '2026-03-31');
  assert.equal(s.debts[0].parcelaAtual, 3);
});

test('A5: cronograma restante usa o dia original com limite no fim do mês', () => {
  const d = divida({ parcelas: 4 });
  assert.deepEqual(E.debtInstallments(d).map((p) => p.vencimento), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
});

test('C2: pagar parcela gera despesa paga vinculada com valor e data', () => {
  const s = base({ debts: [divida()] });
  const r = E.payDebtInstallment(s, 'd1', { data: '2026-01-30', valorPago: 10250 }, '2026-01-31');
  assert.ok(r.ok);
  assert.equal(s.expenses.length, 1);
  const e = s.expenses[0];
  assert.equal(e.pago, true);
  assert.equal(e.valor, 10000);
  assert.equal(e.valorPago, 10250);
  assert.equal(e.dataPagamento, '2026-01-30');
  assert.equal(e.vencimento, '2026-01-31');
  assert.deepEqual(e.origem, { tipo: 'divida', id: 'd1', parcela: 1 });
  assert.equal(E.expenseAjuste(e), 250);            // juros/multa
});

test('C2: última parcela quita a dívida', () => {
  const s = base({ debts: [divida({ parcelas: 1 })] });
  const r = E.payDebtInstallment(s, 'd1', {}, '2026-01-31');
  assert.ok(r.quitada);
  assert.equal(s.debts[0].pago, true);
  assert.equal(E.payDebtInstallment(s, 'd1', {}, '2026-01-31').ok, false);
});

test('C2: resumo do mês inclui parcelas de dívidas em aberto e as já pagas', () => {
  const s = base({ debts: [divida({ vencimento: '2026-09-10', diaOriginal: 10, parcelas: 6 })], expenses: [] });
  let r = E.monthSummary(s, '2026-09-05');
  assert.equal(r.previsto.detalhe.dividas, 10000);
  assert.equal(r.previsto.saidas, 10000);
  E.payDebtInstallment(s, 'd1', { data: '2026-09-05' }, '2026-09-05');
  r = E.monthSummary(s, '2026-09-05');
  // a parcela paga virou despesa do mês; a próxima (10/10) fica fora de setembro: sem dupla contagem
  assert.equal(r.previsto.detalhe.dividas, 0);
  assert.equal(r.previsto.detalhe.despesas, 10000);
  assert.equal(r.previsto.saidas, 10000);
  assert.equal(r.caixa.saidas, 10000);
});

test('M1: valor pago diferente vira juros/multa ou desconto; data futura é recusada', () => {
  const s = base({ expenses: [{ id: 'e1', valor: 5000, descricao: 'Luz', vencimento: '2026-09-10', pago: false, dataPagamento: null, valorPago: null, origem: null, recorrenciaId: '', competencia: '' }] });
  assert.equal(E.payExpense(s, 'e1', { data: '2026-10-01' }, '2026-09-30').ok, false);
  assert.equal(E.payExpense(s, 'e1', { data: '2026-09-30', valorPago: 0 }, '2026-09-30').ok, false);
  const r = E.payExpense(s, 'e1', { data: '2026-09-28', valorPago: 4800 }, '2026-09-30');
  assert.equal(r.ok, true);
  assert.equal(r.ajuste, -200);                       // desconto
  assert.equal(s.expenses[0].dataPagamento, '2026-09-28');
  assert.equal(E.payExpense(s, 'e1', {}, '2026-09-30').ok, false);
});

test('M1: estornar pagamento devolve a despesa para em aberto', () => {
  const s = base({ expenses: [{ id: 'e1', valor: 5000, descricao: 'Luz', vencimento: '2026-09-10', pago: false, dataPagamento: null, valorPago: null, origem: null, recorrenciaId: '', competencia: '' }] });
  E.payExpense(s, 'e1', { data: '2026-09-10', valorPago: 5100 }, '2026-09-30');
  assert.equal(E.unpayExpense(s, 'e1').ok, true);
  const e = s.expenses[0];
  assert.deepEqual([e.pago, e.dataPagamento, e.valorPago], [false, null, null]);
  assert.equal(E.unpayExpense(s, 'e1').ok, false);
});

test('M3: desfazer pagamento de parcela restaura parcela, vencimento e remove a despesa', () => {
  const s = base({ debts: [divida()] });
  E.payDebtInstallment(s, 'd1', { data: '2026-01-31' }, '2026-01-31');
  E.payDebtInstallment(s, 'd1', { data: '2026-02-28' }, '2026-02-28');
  const primeira = s.expenses[0];
  // só a parcela mais recente pode ser estornada
  assert.equal(E.unpayExpense(s, primeira.id).ok, false);
  const seg = s.expenses[1];
  assert.equal(E.unpayExpense(s, seg.id).ok, true);
  assert.equal(s.debts[0].parcelaAtual, 2);
  assert.equal(s.debts[0].vencimento, '2026-02-28');
  assert.equal(s.expenses.length, 1);
  assert.equal(E.undoDebtPayment(s, 'd1').ok, true);
  assert.equal(s.debts[0].parcelaAtual, 1);
  assert.equal(s.debts[0].vencimento, '2026-01-31');
  assert.equal(E.undoDebtPayment(s, 'd1').ok, false);
});

test('M3: estornar a parcela que quitou reabre a dívida', () => {
  const s = base({ debts: [divida({ parcelas: 1 })] });
  E.payDebtInstallment(s, 'd1', {}, '2026-01-31');
  assert.equal(s.debts[0].pago, true);
  E.undoDebtPayment(s, 'd1');
  assert.equal(s.debts[0].pago, false);
  assert.equal(s.debts[0].parcelaAtual, 1);
});

test('M2: saldo devedor por dívida e total (nominal)', () => {
  const s = base({ debts: [divida({ parcelas: 12, parcelaAtual: 5, valorParcela: 20000 }), divida({ id: 'd2', parcelas: 2, valorParcela: 5000 }), divida({ id: 'd3', pago: true, parcelaAtual: 3 })] });
  assert.equal(E.debtRemainingCount(s.debts[0]), 8);
  assert.equal(E.debtSaldo(s.debts[0]), 160000);
  assert.equal(E.debtSaldo(s.debts[2]), 0);
  assert.equal(E.debtSaldoTotal(s), 160000 + 10000);
});

test('M8: despesa vinculada a fatura ou dívida não pode ser excluída em silêncio', () => {
  const s = base({
    expenses: [
      { id: 'ef', valor: 100, descricao: 'Fatura', vencimento: '2026-09-10', pago: false, origem: { tipo: 'fatura', id: 'f1', parcela: 0 }, recorrenciaId: '', competencia: '' },
      { id: 'ed', valor: 100, descricao: 'Parcela', vencimento: '2026-09-10', pago: true, origem: { tipo: 'divida', id: 'd1', parcela: 1 }, recorrenciaId: '', competencia: '' },
      { id: 'el', valor: 100, descricao: 'Livre', vencimento: '2026-09-10', pago: false, origem: null, recorrenciaId: '', competencia: '' }]
  });
  assert.equal(E.canDeleteExpense(s, 'ef').ok, false);
  assert.equal(E.canDeleteExpense(s, 'ef').vinculo, 'fatura');
  assert.equal(E.deleteExpense(s, 'ed').ok, false);
  assert.equal(E.deleteExpense(s, 'el').ok, true);
  assert.equal(s.expenses.length, 2);
});

test('A1: caixa usa data de pagamento; previsto usa vencimento; atraso de meses anteriores separado', () => {
  const s = base({
    income: [{ id: 'i1', valor: 300000, descricao: 'Salário', data: '2026-09-01' }, { id: 'i2', valor: 50000, descricao: 'Freela', data: '2026-09-25' }],
    expenses: [
      // vencia em agosto, paga em setembro: entra no caixa de setembro, não no previsto de setembro
      { id: 'a', valor: 10000, descricao: 'A', vencimento: '2026-08-20', pago: true, dataPagamento: '2026-09-03', valorPago: 10500, origem: null },
      // vence em setembro, ainda em aberto
      { id: 'b', valor: 20000, descricao: 'B', vencimento: '2026-09-20', pago: false, dataPagamento: null, valorPago: null, origem: null },
      // vence em setembro, paga em setembro
      { id: 'c', valor: 30000, descricao: 'C', vencimento: '2026-09-08', pago: true, dataPagamento: '2026-09-08', valorPago: 30000, origem: null },
      // atrasada de agosto
      { id: 'd', valor: 7000, descricao: 'D', vencimento: '2026-08-10', pago: false, dataPagamento: null, valorPago: null, origem: null }]
  });
  const r = E.monthSummary(s, '2026-09-10');
  assert.equal(r.caixa.entradas, 300000);              // freela (25/09) ainda é futuro
  assert.equal(r.caixa.saidas, 10500 + 30000);
  assert.equal(r.caixa.resultado, 300000 - 40500);
  assert.equal(r.previsto.entradas, 350000);
  assert.equal(r.previsto.saidas, 20000 + 30000);
  assert.deepEqual(r.atrasoAnterior, { total: 7000, qtd: 1 });
});
