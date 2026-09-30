'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/ledger-engine.js');

function cenario() {
  const s = E.freshState();
  Object.assign(s.card, { limite: 500000, fechamento: 25, vencimentoDia: 5 });
  s.income.push(E.makeIncome({ valor: 500000, descricao: 'Salário', data: '2026-09-05', categoria: 'Salário' }));
  s.income.push(E.makeIncome({ valor: 20000, descricao: 'Freela', data: '2026-09-20', categoria: 'Outros' }));
  s.income.push(E.makeIncome({ valor: 99999, descricao: 'Outro mês', data: '2026-10-05' }));
  s.expenses.push(E.makeExpense({ valor: 150000, descricao: 'Aluguel', vencimento: '2026-09-10', categoria: 'Moradia', natureza: 'fixa' }));
  s.expenses.push(E.makeExpense({ valor: 30000, descricao: 'Médico', vencimento: '2026-09-12', categoria: 'Saúde', natureza: 'variavel' }));
  s.debts.push({ id: 'd1', valorParcela: 40000, descricao: 'Financiamento', parcelas: 12, parcelaAtual: 1, vencimento: '2026-09-15', diaOriginal: 15, pago: false, pagas: [], valorContratado: null, taxa: null, categoria: 'Dívidas' });
  E.addCardPurchase(s, { valor: 60000, descricao: 'Geladeira', data: '2026-09-10', categoria: 'Moradia', parcelas: 3 });
  E.addCardPurchase(s, { valor: 5000, descricao: 'Estorno', data: '2026-09-11', categoria: 'Alimentação', tipo: 'credito' });
  E.addCardPurchase(s, { valor: 8000, descricao: 'Mercado', data: '2026-09-12', categoria: 'Alimentação' });
  return s;
}

test('M4: relatório mensal separa receitas, fixas, variáveis, dívidas e resultado', () => {
  const r = E.monthReport(cenario(), '2026-09');
  assert.equal(r.receitas, 520000);
  assert.equal(r.fixas, 150000);
  assert.equal(r.dividas, 40000);
  // variáveis: médico 30000 + geladeira (1ª parcela 20000) − estorno 5000 + mercado 8000
  assert.equal(r.variaveis, 30000 + 20000 - 5000 + 8000);
  assert.equal(r.totalDespesas, 150000 + 53000 + 40000);
  assert.equal(r.resultado, 520000 - 243000);
});

test('M4: parcela do cartão conta no mês da própria parcela', () => {
  const s = cenario();
  assert.equal(E.monthReport(s, '2026-10').variaveis, 20000);
  assert.equal(E.monthReport(s, '2026-11').variaveis, 20000);
  assert.equal(E.monthReport(s, '2026-12').variaveis, 0);
});

test('M4: fechar a fatura não duplica nem remove gastos do relatório', () => {
  const s = cenario();
  const antes = E.monthReport(s, '2026-09');
  const r = E.closeInvoice(s, '2026-09-25', '2026-09-30');
  assert.equal(r.ok, true);
  const depois = E.monthReport(s, '2026-09');
  assert.equal(depois.variaveis, antes.variaveis);
  assert.equal(depois.totalDespesas, antes.totalDespesas);
  assert.equal(E.monthReport(s, '2026-10').variaveis, 20000);
});

test('M4: despesas por categoria (cartão, despesas e dívidas juntos)', () => {
  const p = E.monthReport(cenario(), '2026-09').despesasPorCategoria;
  assert.equal(p['Moradia'], 150000 + 20000);
  assert.equal(p['Saúde'], 30000);
  assert.equal(p['Alimentação'], 8000 - 5000);
  assert.equal(p['Dívidas'], 40000);
});

test('M4: parcela de dívida paga entra em "dívidas" sem duplicar', () => {
  const s = cenario();
  E.payDebtInstallment(s, 'd1', { data: '2026-09-15' }, '2026-09-15');
  const r = E.monthReport(s, '2026-09');
  assert.equal(r.dividas, 40000);
  assert.equal(E.monthReport(s, '2026-10').dividas, 40000);        // próxima parcela
});

test('M4: fatura legada (sem itens) entra pelo valor da despesa, em variáveis', () => {
  const s = E.normalizeState({ expenses: [{ id: 'e', valor: 100, descricao: 'Fatura', vencimento: '2026-09-05' }], card: { faturas: [{ id: 'f', total: 100, dataFechamento: '2026-08-25', despesaId: 'e' }] } });
  assert.equal(E.monthReport(s, '2026-09').variaveis, 10000);
});

test('M4: orçamento por categoria com alertas de 70% e 90%', () => {
  const s = cenario();
  E.setBudget(s, 'Moradia', 200000);          // gasto 170000 = 85%
  E.setBudget(s, 'Saúde', 32000);             // 30000 = 93,75%
  E.setBudget(s, 'Lazer', 10000);             // 0%
  E.setBudget(s, 'Alimentação', 2000);        // gasto 3000 > orçamento
  const st = Object.fromEntries(E.budgetStatus(s, '2026-09').map((x) => [x.categoria, x]));
  assert.equal(st['Moradia'].nivel, 'warn');
  assert.equal(st['Saúde'].nivel, 'danger');
  assert.equal(st['Lazer'].nivel, 'ok');
  assert.equal(st['Alimentação'].estourou, true);
  assert.equal(st['Moradia'].restante, 30000);
});

test('M4: setBudget valida, cria categoria nova e remove com valor 0', () => {
  const s = E.freshState();
  assert.equal(E.setBudget(s, '  ', 100).ok, false);
  assert.equal(E.setBudget(s, 'Pets', -1).ok, false);
  assert.equal(E.setBudget(s, 'Pets', 15000).ok, true);
  assert.ok(s.categorias.includes('Pets'));
  assert.equal(s.orcamentos['Pets'], 15000);
  E.setBudget(s, 'Pets', 0);
  assert.equal(s.orcamentos['Pets'], undefined);
});

test('M4: categorias e orçamentos sobrevivem à normalização', () => {
  const s = cenario(); E.setBudget(s, 'Pets', 15000);
  const n = E.normalizeState(JSON.parse(JSON.stringify(s)));
  assert.equal(n.orcamentos['Pets'], 15000);
  assert.ok(n.categorias.includes('Pets'));
  assert.equal(n.card.lancamentos.find((l) => l.descricao === 'Geladeira').categoria, 'Moradia');
});
