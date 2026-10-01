/** Painel Apoiar · Avaliar · Sugerir: integração estática (CSP, scripts, cache offline). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const PAGES = ["index.html"];

for (const page of PAGES) {
  const html = read(page);
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];

  test(`${page}: CSP libera só o Firebase necessário`, () => {
    assert.match(csp, /script-src 'self' https:\/\/www\.gstatic\.com;/);
    assert.match(csp, /connect-src 'self' https:\/\/firestore\.googleapis\.com/);
    assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/);
  });

  test(`${page}: painel carregado depois do app, sem botão flutuante`, () => {
    assert.match(html, /<link rel="stylesheet" href="apoio\/apoio\.css" id="dz-style">/);
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(scripts.slice(-2), ['apoio/feedback.js', 'apoio/doacao.js']);
    assert.match(html, /<script src="apoio\/doacao\.js" data-app="LIVROCAIXA" data-flutuante="false"><\/script>/);
  });
}

test('service worker guarda o painel para uso offline', () => {
  const sw = read('sw.js');
  for (const f of ['apoio.css', 'doacao.js', 'feedback.js', 'qrcode.js']) assert.ok(sw.includes(`'./apoio/${f}'`), f);
});

test('id do app está na lista do feedback.js', () => {
  assert.match(read('apoio/feedback.js'), /'LIVROCAIXA'/);
});
