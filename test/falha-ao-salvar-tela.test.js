// Falha de gravação na tela (app.js real num DOM falso): reverte desde a PRIMEIRA falha da sessão e não perde o que o usuário digitou.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../src/ledger-engine.js');
const { bootLivroCaixa } = require('./helpers-app.js');

const STATE_KEY = 'livro_caixa_state_v2';
const MSG = 'Não foi possível salvar. A última alteração não foi gravada.';

function estadoExistente() {
  const s = Engine.freshState();
  s.expenses.push(Engine.makeExpense({ valor: 1000, descricao: 'Aluguel', vencimento: '2026-12-05', categoria: 'Moradia', natureza: 'fixa' }));
  return s;
}
function preencherDespesa($, desc) {
  $('dValor').value = '25,00'; $('dDesc').value = desc; $('dVenc').value = '2026-12-10'; $('dRep').value = 'unica';
}
const despesasGravadas = (store) => JSON.parse(store[STATE_KEY]).expenses.map((e) => e.descricao);

test('BUG-1: com dados já existentes, a primeira falha reverte; falhas repetidas não empilham; ao voltar, só persiste o que o usuário confirmou', async () => {
  let falha = false;
  const inicial = estadoExistente();
  const { $, store, tick, mensagens } = await bootLivroCaixa({ preset: { [STATE_KEY]: JSON.stringify(inicial) }, flushFalha: () => falha });
  assert.deepEqual(despesasGravadas(store), ['Aluguel']);

  falha = true;
  preencherDespesa($, 'Mercado A'); await $('formDespesa').fire('submit'); await tick();
  assert.deepEqual(despesasGravadas(store), ['Aluguel'], 'primeira falha: nada de Mercado A no armazenamento');
  preencherDespesa($, 'Mercado B'); await $('formDespesa').fire('submit'); await tick();
  assert.deepEqual(despesasGravadas(store), ['Aluguel'], 'segunda falha não empilha');
  assert.ok(mensagens.filter((m) => m === MSG).length >= 2, 'avisou nas duas falhas');

  falha = false;
  preencherDespesa($, 'Farmácia'); await $('formDespesa').fire('submit'); await tick();
  assert.deepEqual(despesasGravadas(store), ['Aluguel', 'Farmácia'], 'só a despesa confirmada é gravada (nenhuma das avisadas como não salvas)');
});

test('UX: se a gravação falha o formulário NÃO é limpo; se dá certo, é limpo', async () => {
  let falha = true, resets = 0;
  const { $, tick } = await bootLivroCaixa({ preset: { [STATE_KEY]: JSON.stringify(estadoExistente()) }, flushFalha: () => falha });
  $('formDespesa').reset = () => { resets++; };
  preencherDespesa($, 'Mercado');
  await $('formDespesa').fire('submit'); await tick();
  assert.equal(resets, 0, 'falhou: mantém o que foi digitado');
  assert.equal($('dDesc').value, 'Mercado');
  falha = false;
  await $('formDespesa').fire('submit'); await tick();
  assert.equal(resets, 1, 'gravou: limpa');
});
