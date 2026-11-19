// Falha ao gravar: avisa, volta ao último estado gravado e nunca deixa a tela dizer "salvo" sem ter gravado.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Engine = require('../src/ledger-engine.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const app = read('app.js');

test('gravarComReversao: sucesso devolve o JSON novo como gravado', async () => {
  const chamadas = [];
  const r = await Engine.gravarComReversao('{"v":2}', async (j) => { chamadas.push(j); }, '{"v":1}');
  assert.deepEqual(r, { ok: true, gravado: '{"v":2}' });
  assert.deepEqual(chamadas, ['{"v":2}']);
});

test('gravarComReversao: falha (assíncrona ou síncrona) não lança e devolve o último gravado', async () => {
  const a = await Engine.gravarComReversao('{"v":2}', async () => { throw new Error('QuotaExceededError'); }, '{"v":1}');
  assert.deepEqual(a, { ok: false, gravado: '{"v":1}' });
  const b = await Engine.gravarComReversao('{"v":2}', () => { throw new Error('x'); }, '{"v":1}');
  assert.deepEqual(b, { ok: false, gravado: '{"v":1}' });
});

test('mensagem exata de falha ao salvar', () => {
  assert.equal(Engine.MSG_FALHA_SALVAR, 'Não foi possível salvar. A última alteração não foi gravada.');
});

test('mensagemAoUsuario: deixa passar mensagem do app e esconde a técnica', () => {
  assert.equal(Engine.mensagemAoUsuario(new Error('Backup de outro aplicativo.'), 'padrão'), 'Backup de outro aplicativo.');
  assert.equal(Engine.mensagemAoUsuario(new Error('quota exceeded'), 'padrão'), 'padrão');
  assert.equal(Engine.mensagemAoUsuario(null, 'padrão'), 'padrão');
});

test('app.js: commit espera o resultado da gravação e a importação só diz "importado" se gravou', () => {
  assert.match(app, /function commit\(\)\{[^}]*return persist\(\)/);
  assert.match(app, /if \(!await commit\(\)\) return;/);
  assert.doesNotMatch(app, /function commit\(\)\{[^}]*\bsave\(\);/, 'commit não chama save() solto');
});

test('app.js: persist avisa com a mensagem do engine, reverte ao último gravado e registra só mensagem fixa', () => {
  const persist = app.slice(app.indexOf('async function persist()'), app.indexOf('function escapeHtml'));
  assert.match(persist, /Engine\.MSG_FALHA_SALVAR/);
  assert.match(persist, /normalizeState\(JSON\.parse\(lastSavedJson\)\)/);
  assert.match(persist, /console\.error\('Livro-Caixa: falha ao gravar os dados\.'\)/);
  assert.doesNotMatch(persist, /err\.message|error\.message/);
});

test('app.js e Program.js idênticos', () => {
  assert.equal(app, read('Program.js'));
});
