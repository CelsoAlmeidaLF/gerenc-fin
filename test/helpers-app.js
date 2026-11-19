// Roda src/app.js num DOM falso (Proxy genérico) para testar o comportamento de tela de ponta a ponta.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SRC = path.join(__dirname, '..', 'src');

function makeStub(id, extra) {
  const store = Object.assign({ id, value: '', textContent: '', innerHTML: '', className: '', children: [], handlers: {}, dataset: {} }, extra || {});
  const cls = new Set();
  const classList = { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), toggle: (c, on) => { (on === undefined ? !cls.has(c) : on) ? cls.add(c) : cls.delete(c); }, contains: (c) => cls.has(c) };
  const target = function () {};
  const p = new Proxy(target, {
    get(_, k) {
      if (k === 'classList') return classList;
      if (k === 'addEventListener') return (t, fn) => { (store.handlers[t] = store.handlers[t] || []).push(fn); };
      if (k === 'fire') return (t, e) => Promise.all((store.handlers[t] || []).map((fn) => fn(Object.assign({ target: p, preventDefault() {} }, e))));
      if (k === 'showModal') return () => { setImmediate(() => { p.close(); }); };
      if (k === 'close') return () => { if (typeof store.onclose === 'function') store.onclose(); };
      if (k === 'querySelectorAll') return () => [];
      if (k === 'closest') return () => null;
      if (k === Symbol.toPrimitive) return () => '';
      if (k in store) return store[k];
      return makeStub(String(k));
    },
    set(_, k, v) { store[k] = v; return true; },
    apply() { return makeStub('ret'); }
  });
  return p;
}

/**
 * @param {object} o { preset: {chave: texto}, flushFalha: () => boolean }
 * Devolve { $, store, tick, mensagens (textos de diálogos), erros (console.error) }.
 */
async function bootLivroCaixa(o = {}) {
  const els = {};
  const mensagens = [];
  const erros = [];
  const doc = {
    getElementById: (id) => els[id] || (els[id] = makeStub(id)),
    createElement: (tag) => {
      const el = makeStub(tag);
      if (tag === 'b') el.__isTitle = true;
      return el;
    },
    querySelector: () => makeStub('q'), querySelectorAll: () => [], addEventListener() {},
    body: makeStub('body'), documentElement: makeStub('html')
  };
  const store = Object.assign({}, o.preset || {});
  const ls = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    flush: async () => { if (o.flushFalha && o.flushFalha()) throw new Error('QuotaExceededError'); }
  };
  const ctx = {
    console: { error: (m) => erros.push(String(m)), log() {}, warn() {} }, setTimeout, clearTimeout, setInterval: () => 0, setImmediate, Date, Math, Number, JSON, Promise, Object, Array, String, parseInt, parseFloat, isNaN, Uint8Array, TextEncoder, btoa: (s) => Buffer.from(s, 'binary').toString('base64'), atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    document: doc, history: {}, crypto: { getRandomValues: (a) => a },
    FinancIcons: { svg: () => '' }, FinancSettings: { addSection() {}, open() {} },
    FinancCert: { linked: true, current: null, find: () => null }
  };
  ctx.addEventListener = () => {}; ctx.scrollTo = () => {};
  ctx.window = ctx;
  ctx.vaultReady = Promise.resolve();
  ctx.lockVault = (e) => { if (o.debug) erros.push("lockVault"); };
  ctx.secureStorage = ls;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'ledger-engine.js'), 'utf8').replace(/^[\s\S]*$/, (m) => m) + '\nthis.LedgerEngine = (typeof LedgerEngine!=="undefined")?LedgerEngine:undefined;', ctx, { filename: 'ledger-engine.js' });
  // Intercepta títulos dos diálogos de aviso (showMessage): o <b> recebe o título e o <p class="vault-dim"> o texto.
  const origCreate = doc.createElement;
  doc.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag === 'p') {
      const prox = el;
      return new Proxy(function () {}, {
        get: (_, k) => prox[k],
        set: (_, k, v) => { prox[k] = v; if (k === 'textContent' && v) mensagens.push(String(v)); return true; }
      });
    }
    return el;
  };
  const fonte = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8').replace('})().catch(() => window.lockVault());', '})().catch((e) => { window.__erroInit = e; window.lockVault(); });');
  vm.runInContext(fonte, ctx, { filename: 'app.js' });
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  await tick(80);
  if (ctx.__erroInit) throw ctx.__erroInit;
  return { $: doc.getElementById, store, tick, mensagens, erros, ctx };
}
module.exports = { bootLivroCaixa };
