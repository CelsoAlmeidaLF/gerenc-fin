'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/ledger-engine.js');

test('A6: parseCents converte texto/número em centavos sem erro de float', () => {
  assert.equal(E.parseCents('12.34'), 1234);
  assert.equal(E.parseCents('12,34'), 1234);
  assert.equal(E.parseCents('1.234,56'), 123456);
  assert.equal(E.parseCents('1,234.56'), 123456);
  assert.equal(E.parseCents('R$ 0,10'), 10);
  assert.equal(E.parseCents(0.1), 10);
  assert.equal(E.parseCents(1.005), 101);   // 1.005 * 100 em float dá 100.49999...
  assert.equal(E.parseCents('19.999'), 2000);
  assert.equal(E.parseCents(''), null);
  assert.equal(E.parseCents('abc'), null);
  assert.equal(E.parseCents(NaN), null);
});

test('A6: somas em centavos não acumulam erro (0,1 + 0,2 = 0,30)', () => {
  const a = E.parseCents(0.1), b = E.parseCents(0.2);
  assert.equal(a + b, 30);
  assert.equal(E.sum(Array(10).fill(E.parseCents('0.1')), (x) => x), 100);
  // em float: 0.1 + 0.2 !== 0.3
  assert.notEqual(0.1 + 0.2, 0.3);
});

test('A6: fmtBRL formata centavos apenas na exibição', () => {
  const n = (s) => s.replace(/ /g, ' ');
  assert.equal(n(E.fmtBRL(123456)), 'R$ 1.234,56');
  assert.equal(n(E.fmtBRL(5)), 'R$ 0,05');
  assert.equal(n(E.fmtBRL(0)), 'R$ 0,00');
  assert.equal(n(E.fmtBRL(undefined)), 'R$ 0,00');
});

test('B5: teto de R$ 999.999.999,99 (antes 1e15)', () => {
  assert.equal(E.MAX_CENTS, 99999999999);
  assert.equal(E.safeCents('999999999.99'), 99999999999);
  assert.equal(E.safeCents('1000000000.00'), 0);
  assert.equal(E.safeCents(1e15), 0);
  assert.equal(E.safeCents(99999999999, true), 99999999999);
  assert.equal(E.safeCents(100000000000, true), 0);
  assert.equal(E.safeCents(-5, true), 0);
});

test('migração: estado legado (reais, float, sem schemaVersion) vira centavos', () => {
  const legado = {
    expenses: [{ id: 'e1', valor: 1234.56, descricao: 'Aluguel', vencimento: '2026-09-05', pago: true, dataPagamento: '2026-09-04' },
      { id: 'e2', valor: 0.1, descricao: 'Bala', vencimento: '2026-09-06', pago: false, dataPagamento: null }],
    income: [{ id: 'i1', valor: 5000, descricao: 'Salário', data: '2026-09-01' }],
    card: { limite: 1500.5, fechamento: 25, lancamentos: [{ id: 'l1', valor: 99.99, descricao: 'Mercado', data: '2026-09-10' }],
      faturas: [{ id: 'f1', total: 300.25, dataFechamento: '2026-08-25', despesaId: 'e1' }, { id: 'f2', total: 10, dataFechamento: '2026-07-25' }] },
    debts: [{ id: 'd1', valorParcela: 250.75, descricao: 'Empréstimo', parcelas: 12, parcelaAtual: 3, vencimento: '2026-08-31', pago: false }]
  };
  const s = E.normalizeState(legado);
  assert.equal(s.schemaVersion, 2);
  assert.equal(s.expenses[0].valor, 123456);
  assert.equal(s.expenses[0].valorPago, 123456);
  assert.equal(s.expenses[0].dataPagamento, '2026-09-04');
  assert.equal(s.expenses[1].valor, 10);
  assert.equal(s.expenses[1].valorPago, null);
  assert.equal(s.income[0].valor, 500000);
  assert.equal(s.card.limite, 150050);
  assert.equal(s.card.fechamento, 25);
  assert.equal(s.card.vencimentoDia, 5);            // default derivado do fechamento
  assert.equal(s.card.lancamentos[0].valor, 9999);
  assert.equal(s.card.lancamentos[0].tipo, 'compra');
  assert.equal(s.card.faturas[0].total, 30025);
  assert.equal(s.debts[0].valorParcela, 25075);
  assert.deepEqual(s.debts[0].pagas, []);
  assert.equal(s.debts[0].categoria, 'Dívidas');
  assert.ok(s.categorias.includes('Outros'));
  assert.equal(s.contas, undefined);
});

test('estado e backup antigos com contas: contas, conciliação e vínculos são descartados, lançamentos ficam', () => {
  const s = E.normalizeState({
    schemaVersion: 2,
    contas: [{ id: 'c1', nome: 'Corrente', saldoInicial: 100000, dataSaldoInicial: '2026-09-01' }],
    reconciliacao: { c1: { saldoBanco: 120000, data: '2026-09-30' } },
    expenses: [{ id: 'e1', valor: 5000, descricao: 'Luz', vencimento: '2026-09-10', pago: true, dataPagamento: '2026-09-09', valorPago: 5000, contaId: 'c1', conferido: true }],
    income: [{ id: 'i1', valor: 300000, descricao: 'Salário', data: '2026-09-05', contaId: 'c1', conferido: true }],
    recorrencias: [{ id: 'r1', tipo: 'entrada', valor: 300000, descricao: 'Salário', inicio: '2026-09-05', contaId: 'c1' }]
  });
  assert.equal(s.contas, undefined);
  assert.equal(s.reconciliacao, undefined);
  assert.equal(s.expenses.length, 1);
  assert.equal(s.income.length, 1);
  assert.equal(s.recorrencias.length, 1);
  for (const x of [s.expenses[0], s.income[0], s.recorrencias[0]]) {
    assert.equal(x.contaId, undefined);
    assert.equal(x.conferido, undefined);
  }
  assert.equal(E.addAccount, undefined);
});

test('M8: fatura sem despesaId fica com vínculo vazio; com id existente marca a origem da despesa', () => {
  const s = E.normalizeState({
    expenses: [{ id: 'e1', valor: 10, descricao: 'Fatura', vencimento: '2026-09-05' }],
    card: { faturas: [{ id: 'f1', total: 10, dataFechamento: '2026-08-25', despesaId: 'e1' }, { id: 'f2', total: 5, dataFechamento: '2026-07-25' }] }
  });
  assert.equal(s.card.faturas[1].despesaId, '');
  assert.equal(s.card.faturas[0].despesaId, 'e1');
  assert.deepEqual(s.expenses[0].origem, { tipo: 'fatura', id: 'f1', parcela: 0 });
  assert.equal(s.card.faturas[0].vencimento, '2026-09-05');
});

test('migração é idempotente: normalizar um estado já no schema 2 não altera valores', () => {
  const uma = E.normalizeState({ income: [{ id: 'i', valor: 12.34, descricao: 'x', data: '2026-01-01' }] });
  const duas = E.normalizeState(JSON.parse(JSON.stringify(uma)));
  assert.equal(uma.income[0].valor, 1234);
  assert.equal(duas.income[0].valor, 1234);
  assert.deepEqual(duas, uma);
});

test('normalizeState valida entradas hostis sem lançar', () => {
  for (const lixo of [null, undefined, 42, 'x', [], { expenses: 'x', card: 5, debts: [null, 3, {}] }]) {
    const s = E.normalizeState(lixo);
    assert.equal(s.schemaVersion, 2);
    assert.deepEqual(s.expenses, []);
    assert.deepEqual(s.debts, []);
  }
  const s = E.normalizeState({ expenses: [{ valor: -5, descricao: 'neg', vencimento: '2026-02-30' }, { valor: 1e20, descricao: 'grande', vencimento: '2026-02-10' }] });
  assert.equal(s.expenses.length, 1);            // data inexistente descartada
  assert.equal(s.expenses[0].valor, 0);          // acima do teto vira 0
});

test('dívida legada: dia original vem do vencimento; parcelaAtual limitada ao total', () => {
  const s = E.normalizeState({ debts: [{ valorParcela: 10, descricao: 'x', parcelas: 3, parcelaAtual: 9, vencimento: '2026-01-31' }] });
  assert.equal(s.debts[0].diaOriginal, 31);
  assert.equal(s.debts[0].parcelaAtual, 3);
});
