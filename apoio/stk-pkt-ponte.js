/*!
 * stk-pkt-ponte.js — cliente da ponte do Firebase (carregar antes de stk-pkt-feedback.js / da governança).
 * Abre, só quando preciso, um iframe invisível em https://systekna-ponte.web.app e conversa por postMessage.
 * O app não carrega o SDK do Google: o código de terceiros fica longe do cofre aberto.
 *   SystekPonte.chamar(op, args)   → Promise com o resultado (op: avaliar, sugerir, media, erro)
 *   SystekPonte.fetch(url, init)   → como fetch, para o REST do Firestore da governança (resposta: ok, status, json())
 */
(function () {
  'use strict';
  const PONTE = 'https://systekna-ponte.web.app/';
  const ORIGEM = new URL(PONTE).origin;
  const REST = '/v1/projects/systekna-feedback/databases/(default)/documents/';
  let frame = null, pronto = null, seq = 0;
  const pendentes = new Map();

  addEventListener('message', event => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== ORIGEM) return;
    const m = event.data;
    if (!m || typeof m !== 'object') return;
    if (m.tipo === 'pronta' && frame._ok) { frame._ok(); frame._ok = null; return; }
    const p = typeof m.id === 'string' && pendentes.get(m.id);
    if (!p) return;
    pendentes.delete(m.id); clearTimeout(p.timer);
    if (m.ok) p.ok(m.resultado); else p.erro(new Error(m.erro || 'Falha no serviço.'));
  });

  function abrir() {
    if (pronto) return pronto;
    pronto = new Promise((ok, erro) => {
      frame = document.createElement('iframe');
      frame.src = PONTE; frame.title = 'Serviço de avaliações e governança';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.referrerPolicy = 'no-referrer'; frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
      const desistir = setTimeout(() => { pronto = null; frame.remove(); frame = null; erro(new Error('Sem conexão com o serviço. Tente de novo mais tarde.')); }, 15000);
      frame._ok = () => { clearTimeout(desistir); ok(); };
      // Cumprimenta até a ponte responder (o script dela pode carregar depois do evento load).
      frame.addEventListener('load', () => {
        let n = 0;
        const ola = () => { if (!frame || !frame._ok || n++ > 20) return; frame.contentWindow.postMessage({ tipo: 'ola' }, ORIGEM); setTimeout(ola, 300); };
        ola();
      });
      (document.body || document.documentElement).append(frame);
    });
    return pronto;
  }

  async function chamar(op, args, timeout = 20000) {
    await abrir();
    const id = 'm' + (++seq) + '-' + Date.now().toString(36);
    return new Promise((ok, erro) => {
      const timer = setTimeout(() => { pendentes.delete(id); erro(new Error('Tempo esgotado ao contatar o serviço.')); }, timeout);
      pendentes.set(id, { ok, erro, timer });
      frame.contentWindow.postMessage({ id, op, args }, ORIGEM);
    });
  }

  // fetch só para o REST do Firestore do projeto: a ponte acrescenta a chave e o token do App Check.
  async function fetchFirestore(url, init = {}) {
    const u = new URL(url);
    const caminho = decodeURIComponent(u.pathname);
    if (u.origin !== 'https://firestore.googleapis.com' || !caminho.startsWith(REST)) throw new Error('Destino não permitido.');
    const query = {};
    u.searchParams.forEach((v, k) => { if (k !== 'key') query[k] = v; });
    const r = await chamar('rest', { method: String(init.method || 'GET').toUpperCase(), path: caminho.slice(REST.length), query, body: init.body || null });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
  }

  window.SystekPonte = Object.freeze({ chamar, fetch: fetchFirestore, endereco: PONTE });
})();
