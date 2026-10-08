// Testes do log de erros: o que sai do aparelho precisa estar limpo.
// Nos apps, este arquivo fica em test/ e o pacote em src/apoio/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const local = [path.join(__dirname, '../shared/stk-pkg-erros.js'), path.join(__dirname, '../src/apoio/stk-pkg-erros.js')].find((p) => fs.existsSync(p));
const E = require(local);

const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test('mensagem: tira valores, e-mails e textos entre aspas', () => {
  assert.equal(E.limparMensagem('Saldo R$ 1.234,56 insuficiente'), 'Saldo R$ *** insuficiente');
  assert.equal(E.limparMensagem('Falhou para fulano@gmail.com'), 'Falhou para ***');
  assert.equal(E.limparMensagem('Unexpected token \'a\', "minha senha secreta" is not valid JSON'), 'Unexpected token \'a\', "***" is not valid JSON');
  assert.equal(E.limparMensagem('Valor 98765 fora da faixa'), 'Valor *** fora da faixa');
  assert.equal(E.limparMensagem('US$ 15000 e € 20'), 'US$ *** e € ***');
});

test('mensagem: mantém o que ajuda a achar o bug', () => {
  assert.equal(E.limparMensagem("Cannot read properties of undefined (reading 'map')"), "Cannot read properties of undefined (reading 'map')");
  assert.equal(E.limparMensagem('x is not a function'), 'x is not a function');
  assert.equal(E.limparMensagem('Erro 42 no passo 7'), 'Erro 42 no passo 7', 'números de 1 e 2 dígitos ficam');
});

test('mensagem: endereço sem parâmetros (chave de API na URL não sai)', () => {
  const m = E.limparMensagem('Failed to fetch https://brapi.dev/api/quote/PETR4?token=abc123segredo#x');
  assert.ok(!m.includes('abc123segredo'));
  assert.ok(!m.includes('token'));
  assert.ok(m.includes('https://brapi.dev/api/quote/PETR4'));
});

test('mensagem: espaços normalizados e corte em 300 caracteres', () => {
  assert.equal(E.limparMensagem('  a \n\t b  '), 'a b');
  const longa = E.limparMensagem('x'.repeat(1000));
  assert.equal(longa.length, 300);
  assert.ok(longa.endsWith('…'));
  assert.equal(E.limparMensagem(null), '');
});

test('arquivo: só as 2 últimas partes do caminho, sem domínio nem parâmetros', () => {
  assert.equal(E.limparArquivo('https://celsoalmeidalf.github.io/cripto-sim/src/js/app.js?v=3'), 'js/app.js');
  assert.equal(E.limparArquivo('http://127.0.0.1:8765/stk-app-cripito-sim/src/index.html'), 'src/index.html');
  assert.equal(E.limparArquivo(''), '');
});

test('pilha: Chrome e Safari viram "função arquivo:linha:coluna", até 5 linhas', () => {
  const chrome = 'TypeError: x\n    at render (https://a.github.io/app/src/js/app.js?k=1:120:7)\n    at async iniciar (https://a.github.io/app/src/app.js:9:3)\n    at https://a.github.io/app/src/app.js:1:1';
  assert.equal(E.limparPilha(chrome), 'render js/app.js:120:7\niniciar src/app.js:9:3\nsrc/app.js:1:1');
  const safari = 'msg\nrender@https://a.github.io/app/src/app.js:120:7\n@https://a.github.io/app/src/app.js:1:1';
  assert.equal(E.limparPilha(safari), 'render src/app.js:120:7\nsrc/app.js:1:1');
  const muitas = 'E\n' + Array.from({ length: 12 }, (_, i) => `    at f${i} (https://a/b/c.js:${i + 1}:1)`).join('\n');
  assert.equal(E.limparPilha(muitas).split('\n').length, 5);
  assert.equal(E.limparPilha(undefined), '');
});

test('navegador: só família, versão principal e sistema', () => {
  assert.equal(E.navegador(UA_ANDROID), 'Chrome 141 / Android');
  assert.equal(E.navegador(UA_IPHONE), 'Safari 18 / iOS');
  assert.equal(E.navegador('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'), 'Firefox 131 / Linux');
  assert.equal(E.navegador('Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 Safari/537.36 Edg/141.0'), 'Edge 141 / Windows');
  assert.equal(E.navegador(''), 'outro / outro');
});

test('assinatura: igual para o mesmo erro, diferente se muda versão ou origem', () => {
  const a = E.assinatura('CRIPTO', '1.10.0', 'x is not a function', 'js/app.js:1:1');
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(a, E.assinatura('CRIPTO', '1.10.0', 'x is not a function', 'js/app.js:1:1'));
  assert.notEqual(a, E.assinatura('CRIPTO', '1.10.1', 'x is not a function', 'js/app.js:1:1'));
  assert.notEqual(a, E.assinatura('CRIPTO', '1.10.0', 'x is not a function', 'js/app.js:2:1'));
});

test('montar: registro só com campos permitidos e limpos', () => {
  const erro = new TypeError('Saldo R$ 5.000,00 de fulano@x.com');
  erro.stack = 'TypeError: ...\n    at salvar (https://a.github.io/app/src/app.js?chave=SEGREDO:50:2)';
  const r = E.montar({ tipo: 'erro', erro, arquivo: 'https://a.github.io/app/src/app.js?chave=SEGREDO', linha: 50, coluna: 2 },
    { app: 'INVEST', versao: '1.0.0', ua: UA_ANDROID, agora: 1000 });
  assert.deepEqual(Object.keys(r).sort(), ['app', 'assinatura', 'mensagem', 'navegador', 'origem', 'pilha', 'quando', 'tipo', 'versao']);
  assert.equal(r.mensagem, 'TypeError: Saldo R$ *** de ***');
  assert.equal(r.origem, 'src/app.js:50:2');
  assert.equal(r.pilha, 'salvar src/app.js:50:2');
  assert.equal(r.navegador, 'Chrome 141 / Android');
  assert.ok(!JSON.stringify(r).includes('SEGREDO'));
  assert.ok(!JSON.stringify(r).includes('5.000'));
});

test('montar: promessa rejeitada sem Error e origem vinda da pilha', () => {
  const r = E.montar({ tipo: 'promessa', erro: null, mensagem: 'Promessa rejeitada: timeout 30000' }, { app: 'CAMBIO', versao: '1.10.0', ua: '' });
  assert.equal(r.tipo, 'promessa');
  assert.equal(r.mensagem, 'Promessa rejeitada: timeout ***');
  assert.equal(r.origem, '');
  const e = new Error('falhou'); e.stack = 'Error: falhou\n    at carregar (https://a/x/src/app.js:7:9)';
  assert.equal(E.montar({ tipo: 'console', erro: e }, { app: 'CAMBIO', versao: '1', ua: '' }).origem, 'src/app.js:7:9');
  assert.equal(E.montar({ tipo: 'qualquer', erro: null, mensagem: '' }, { app: 'CAMBIO', versao: '1', ua: '' }).tipo, 'erro');
});

test('podeEnviar: mesmo erro 1× por dia e no máximo 20 envios por dia', () => {
  const dia = 24 * 60 * 60 * 1000, agora = 10 * dia;
  const reg = { assinatura: 'aaaa0000' };
  assert.equal(E.podeEnviar(reg, {}, agora), true);
  assert.equal(E.podeEnviar(reg, { aaaa0000: agora - 1000 }, agora), false);
  assert.equal(E.podeEnviar(reg, { aaaa0000: agora - dia - 1 }, agora), true);
  const cheio = Object.fromEntries(Array.from({ length: E.LIMITE_DIA }, (_, i) => ['x' + i, agora - 1000]));
  assert.equal(E.podeEnviar(reg, cheio, agora), false);
  const velhos = Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['x' + i, agora - 2 * dia]));
  assert.equal(E.podeEnviar(reg, velhos, agora), true);
});
