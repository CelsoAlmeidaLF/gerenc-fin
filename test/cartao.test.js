'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/ledger-engine.js');

function cartao(o) { const s = E.freshState(); Object.assign(s.card, { limite: 100000, fechamento: 25, vencimentoDia: 5 }, o || {}); return s; }
const compra = (s, valor, data, extra) => E.addCardPurchase(s, Object.assign({ valor, descricao: 'x', data }, extra));

test('A3: compra até o dia do fechamento cai na fatura corrente; depois, na seguinte', () => {
  assert.equal(E.closingDateFor('2026-09-10', 25), '2026-09-25');
  assert.equal(E.closingDateFor('2026-09-25', 25), '2026-09-25');
  assert.equal(E.closingDateFor('2026-09-26', 25), '2026-10-25');
  assert.equal(E.closingDateFor('2026-12-30', 25), '2027-01-25');
});

test('A3: vencimento vem do dia de vencimento, não de "hoje + 10"', () => {
  assert.equal(E.dueDateFor('2026-09-25', 5), '2026-10-05');   // vence no mês seguinte ao fechamento
  assert.equal(E.dueDateFor('2026-09-05', 15), '2026-09-15');  // mesmo mês quando o dia é maior
  assert.equal(E.dueDateFor('2026-12-25', 5), '2027-01-05');
  assert.equal(E.dueDateFor('2026-09-25', 25), '2026-10-25');
});

test('B4: fechamento no dia 31 usa o último dia dos meses curtos', () => {
  assert.equal(E.closingDateFor('2026-02-10', 31), '2026-02-28');
  assert.equal(E.closingDateFor('2026-02-28', 31), '2026-02-28');
  assert.equal(E.closingDateFor('2026-03-01', 31), '2026-03-31');
  assert.equal(E.closingDateFor('2026-04-30', 31), '2026-04-30');
  assert.equal(E.closingDateFor('2028-02-29', 31), '2028-02-29');
  assert.equal(E.dueDateFor('2026-02-28', 31), '2026-03-31');   // vencimento 31 em fevereiro (mês seguinte, março)
  assert.equal(E.dueDateFor('2026-01-31', 30), '2026-02-28');
});

test('A3: agrupa lançamentos por ciclo e fecha só depois do fechamento', () => {
  const s = cartao();
  compra(s, 10000, '2026-09-10'); compra(s, 5000, '2026-09-24'); compra(s, 7000, '2026-09-26');
  const ciclos = E.openCycles(s);
  assert.deepEqual(ciclos.map((c) => [c.fechamento, c.vencimento, c.total]), [['2026-09-25', '2026-10-05', 15000], ['2026-10-25', '2026-11-05', 7000]]);
  assert.equal(E.closeInvoice(s, '2026-10-25', '2026-09-30').ok, false);        // ciclo ainda aberto
  const r = E.closeInvoice(s, '2026-09-25', '2026-09-30');
  assert.equal(r.ok, true);
  assert.equal(r.despesa.valor, 15000);
  assert.equal(r.despesa.vencimento, '2026-10-05');
  assert.deepEqual(r.despesa.origem, { tipo: 'fatura', id: r.fatura.id, parcela: 0 });
  assert.equal(r.fatura.despesaId, r.despesa.id);
  assert.equal(s.card.lancamentos.length, 1);                                    // sobrou só o ciclo seguinte
  assert.equal(s.card.lancamentos[0].valor, 7000);
});

test('C3: limite NÃO é liberado ao fechar a fatura; só quando a despesa vinculada é paga', () => {
  const s = cartao({ limite: 100000 });
  compra(s, 30000, '2026-09-10');
  assert.equal(E.cardAvailable(s), 70000);
  const r = E.closeInvoice(s, '2026-09-25', '2026-09-30');
  assert.equal(E.cardUsed(s), 30000);
  assert.equal(E.cardAvailable(s), 70000);                                       // antes do fix voltava a 100000
  E.payExpense(s, r.despesa.id, { data: '2026-10-05' }, '2026-10-05');
  assert.equal(E.cardAvailable(s), 100000);
  E.unpayExpense(s, r.despesa.id);
  assert.equal(E.cardAvailable(s), 70000);                                       // estorno volta a consumir o limite
});

test('C3: disponível = limite − lançamentos abertos − faturas não pagas', () => {
  const s = cartao({ limite: 100000 });
  compra(s, 20000, '2026-08-10');
  const f1 = E.closeInvoice(s, '2026-08-25', '2026-09-30');
  compra(s, 15000, '2026-09-10');
  assert.equal(E.cardOpenTotal(s), 15000);
  assert.equal(E.cardInvoicesUnpaid(s), 20000);
  assert.equal(E.cardAvailable(s), 65000);
  assert.ok(f1.ok);
});

test('C3: fatura legada sem despesa vinculada não trava o limite', () => {
  const s = E.normalizeState({ card: { limite: 1000, faturas: [{ id: 'f', total: 500, dataFechamento: '2026-01-25' }] } });
  assert.equal(E.cardAvailable(s), 100000);
});

test('A4: compra parcelada gera N linhas distribuídas nas faturas seguintes', () => {
  const s = cartao();
  const criadas = compra(s, 30001, '2026-09-10', { parcelas: 3 });
  assert.deepEqual(criadas.map((l) => l.valor), [10001, 10000, 10000]);           // resto na primeira parcela
  assert.equal(E.sum(criadas, (l) => l.valor), 30001);
  assert.deepEqual(criadas.map((l) => l.data), ['2026-09-10', '2026-10-10', '2026-11-10']);
  assert.deepEqual(criadas.map((l) => [l.parcelaAtual, l.parcelas]), [[1, 3], [2, 3], [3, 3]]);
  assert.equal(new Set(criadas.map((l) => l.compraId)).size, 1);
  const ciclos = E.openCycles(s);
  assert.deepEqual(ciclos.map((c) => c.fechamento), ['2026-09-25', '2026-10-25', '2026-11-25']);
  assert.deepEqual(ciclos.map((c) => c.total), [10001, 10000, 10000]);
});

test('A4: limite é reduzido pelo total restante da compra parcelada', () => {
  const s = cartao({ limite: 100000 });
  compra(s, 60000, '2026-09-10', { parcelas: 6 });
  assert.equal(E.cardUsed(s), 60000);
  assert.equal(E.cardAvailable(s), 40000);
  const r = E.closeInvoice(s, '2026-09-25', '2026-09-30');                        // fecha só a parcela 1
  assert.equal(r.despesa.valor, 10000);
  assert.equal(E.cardAvailable(s), 40000);                                        // 50000 restantes + 10000 da fatura
  E.payExpense(s, r.despesa.id, {}, '2026-10-05');
  assert.equal(E.cardAvailable(s), 50000);
});

test('A4: parcela em 31/01 cai em 28/02 e 31/03 (dia original preservado)', () => {
  const s = cartao({ fechamento: 31 });
  const criadas = compra(s, 30000, '2026-01-31', { parcelas: 3 });
  assert.deepEqual(criadas.map((l) => l.data), ['2026-01-31', '2026-02-28', '2026-03-31']);
});

test('B1: crédito/estorno reduz a fatura e o uso do limite', () => {
  const s = cartao();
  compra(s, 30000, '2026-09-10');
  compra(s, 8000, '2026-09-12', { tipo: 'credito', parcelas: 5 });
  assert.equal(E.cardUsed(s), 22000);
  const r = E.closeInvoice(s, '2026-09-25', '2026-09-30');
  assert.equal(r.despesa.valor, 22000);
  assert.equal(r.fatura.itens.length, 2);
});

test('B1: crédito maior que as compras não gera despesa e a sobra abate a próxima fatura', () => {
  const s = cartao();
  compra(s, 5000, '2026-09-10');
  compra(s, 8000, '2026-09-12', { tipo: 'credito' });
  const r = E.closeInvoice(s, '2026-09-25', '2026-09-30');
  assert.equal(r.ok, true);
  assert.equal(r.despesa, null);
  assert.equal(r.fatura.despesaId, '');
  assert.equal(s.expenses.length, 0);
  assert.equal(s.card.lancamentos.length, 1);
  assert.equal(s.card.lancamentos[0].tipo, 'credito');
  assert.equal(s.card.lancamentos[0].valor, 3000);
  assert.equal(E.closingDateFor(s.card.lancamentos[0].data, 25), '2026-10-25');
  assert.equal(E.reopenInvoice(s, r.fatura.id).ok, true);                         // reabrir remove o crédito transportado
  assert.equal(s.card.lancamentos.length, 2);
});

test('M8: reabrir fatura devolve lançamentos e remove a despesa; fatura paga não reabre', () => {
  const s = cartao();
  compra(s, 10000, '2026-09-10'); compra(s, 2000, '2026-09-11');
  const r = E.closeInvoice(s, '2026-09-25', '2026-09-30');
  E.payExpense(s, r.despesa.id, {}, '2026-10-05');
  const bloq = E.reopenInvoice(s, r.fatura.id);
  assert.equal(bloq.ok, false);
  E.unpayExpense(s, r.despesa.id);
  const ok = E.reopenInvoice(s, r.fatura.id);
  assert.equal(ok.ok, true);
  assert.equal(s.card.lancamentos.length, 2);
  assert.equal(s.card.faturas.length, 0);
  assert.equal(s.expenses.length, 0);
});

test('A3: fechar leva junto ciclos anteriores ainda abertos', () => {
  const s = cartao();
  compra(s, 1000, '2026-07-10'); compra(s, 2000, '2026-08-10'); compra(s, 4000, '2026-09-10');
  const r = E.closeInvoice(s, '2026-09-25', '2026-09-30');
  assert.equal(r.despesa.valor, 7000);
  assert.equal(s.card.lancamentos.length, 0);
});

test('resumo previsto inclui a fatura prevista do ciclo aberto no mês do vencimento', () => {
  const s = cartao();
  compra(s, 12000, '2026-09-10');                       // fecha 25/09, vence 05/10
  assert.equal(E.monthSummary(s, '2026-09-30', '2026-10').previsto.detalhe.cartao, 12000);
  assert.equal(E.monthSummary(s, '2026-09-30', '2026-09').previsto.detalhe.cartao, 0);
});

test('A4: excluir uma parcela remove todas as parcelas em aberto da compra', () => {
  const s = cartao();
  const criadas = compra(s, 30000, '2026-09-10', { parcelas: 3 });
  compra(s, 1000, '2026-09-11');
  const r = E.deleteCardItem(s, criadas[1].id);
  assert.equal(r.removidos, 3);
  assert.equal(s.card.lancamentos.length, 1);
  assert.equal(E.deleteCardItem(s, 'nao-existe').ok, false);
});
