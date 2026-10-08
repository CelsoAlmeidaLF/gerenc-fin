/*!
 * stk-pkg-erros.js — log de erros dos apps Systekna
 *
 * Uso (no <head> de cada app, antes dos outros scripts, para pegar erros desde o início):
 *   <script src="apoio/stk-pkg-erros.js" data-app="CRIPTO"></script>
 *
 * O que faz:
 *   1. Captura erros não tratados (window.onerror, unhandledrejection) e console.error.
 *   2. Limpa a mensagem (sem valores, e-mails, textos entre aspas ou endereços com parâmetros).
 *   3. Guarda os últimos 50 neste aparelho (localStorage, por app).
 *   4. Envia ao painel de feedback (coleção "erros") só com permissão:
 *      - "Modo testador" ligado (vale para todos os apps do aparelho) → envia sozinho;
 *      - desligado → aviso discreto "Enviar relatório?", uma vez por sessão.
 *   Nenhum dado financeiro sai do aparelho. O envio usa window.Feedback.relatarErro (stk-pkg-feedback.js).
 *
 * Em Configurações (FinancSettings) aparece a seção "Relatórios de erro".
 * As funções puras (limpar, assinatura, navegador, podeEnviar) são exportadas para os testes no Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.iniciar(root);
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITE_LOCAL = 50;
  const LIMITE_DIA = 20;             // envios por app por dia
  const UM_DIA = 24 * 60 * 60 * 1000;
  const TAM = { mensagem: 300, origem: 120, pilha: 600, navegador: 60 };
  const TIPOS = ['erro', 'promessa', 'console'];

  // ───────────── LIMPEZA (pura) ─────────────
  // Endereço vira só origem + caminho, sem ?parâmetros nem #âncora (o Investimentos leva chave na URL).
  function semParametros(txt) {
    return txt.replace(/\b(https?|blob|file):\/\/[^\s)'"]+/g, (url) => url.replace(/[?#].*$/, ''));
  }

  function limparMensagem(msg) {
    let s = String(msg == null ? '' : msg);
    s = semParametros(s);
    s = s.replace(/[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+/g, '***');          // e-mails
    s = s.replace(/"[^"]*"/g, '"***"');                                 // textos entre aspas (JSON, entradas)
    s = s.replace(/`[^`]*`/g, '`***`');
    s = s.replace(/'[^']{25,}'/g, "'***'");                              // aspas simples longas (nomes de propriedade curtos ficam)
    s = s.replace(/(R\$|US\$|\$|€)\s*[\d.,]+/g, '$1 ***');                // valores em moeda
    s = s.replace(/\d[\d.,]{2,}/g, '***');                              // números com 3+ dígitos
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > TAM.mensagem ? s.slice(0, TAM.mensagem - 1) + '…' : s;
  }

  // "https://x.github.io/app/src/js/app.js?v=2:120:7" → "js/app.js:120:7" (só as 2 últimas partes do caminho)
  function limparArquivo(arq) {
    const s = semParametros(String(arq || '')).replace(/^\w+:\/\/[^/]+/, '');
    const partes = s.split('/').filter(Boolean);
    return partes.slice(-2).join('/').slice(0, TAM.origem);
  }

  // Chrome: "at fn (url:l:c)" / "at url:l:c" · Safari e Firefox: "fn@url:l:c". Linhas que não são quadro (a mensagem) saem.
  function limparPilha(pilha) {
    if (!pilha) return '';
    const linhas = String(pilha).split('\n').map((l) => {
      l = l.trim().replace(/^at\s+/, '');
      const m = l.match(/^(.*?)\s*\((.+):(\d+):(\d+)\)$/) || l.match(/^(?:([^@\s]*)@)?(\S+):(\d+):(\d+)$/);
      if (!m) return '';
      const fn = (m[1] || '').replace(/^async\s+/, '').trim().slice(0, 40);
      return (fn ? fn + ' ' : '') + limparArquivo(m[2]) + ':' + m[3] + ':' + m[4];
    }).filter(Boolean).slice(0, 5);
    const s = linhas.join('\n');
    return s.length > TAM.pilha ? s.slice(0, TAM.pilha) : s;
  }

  // Só família do navegador e sistema: "Chrome 141 / Android"
  function navegador(ua) {
    ua = String(ua || '');
    const so = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
      : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'outro';
    const regras = [[/Edg\/(\d+)/, 'Edge'], [/OPR\/(\d+)/, 'Opera'], [/SamsungBrowser\/(\d+)/, 'Samsung'],
      [/Firefox\/(\d+)/, 'Firefox'], [/FxiOS\/(\d+)/, 'Firefox'], [/CriOS\/(\d+)/, 'Chrome'], [/Chrome\/(\d+)/, 'Chrome'],
      [/Version\/(\d+).*Safari/, 'Safari']];
    for (const [re, nome] of regras) { const m = ua.match(re); if (m) return (nome + ' ' + m[1] + ' / ' + so).slice(0, TAM.navegador); }
    return 'outro / ' + so;
  }

  // Hash curto (FNV-1a) para agrupar o mesmo erro no painel e evitar envio repetido
  function assinatura(app, versao, mensagem, origem) {
    const s = [app, versao, mensagem, origem].join('|');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }

  // Monta o registro limpo a partir do erro bruto
  function montar(bruto, ctx) {
    const err = bruto.erro;
    const nomeErro = err && err.name && err.name !== 'Error' ? err.name + ': ' : '';
    const mensagem = limparMensagem(nomeErro + (err && err.message != null ? err.message : bruto.mensagem || 'Erro desconhecido'))
      || 'Erro sem mensagem';
    const pilha = limparPilha(err && err.stack);
    const origem = bruto.arquivo ? limparArquivo(bruto.arquivo) + (bruto.linha ? ':' + bruto.linha + ':' + (bruto.coluna || 0) : '')
      : (pilha.split('\n')[0] || '').split(' ').pop();
    const tipo = TIPOS.includes(bruto.tipo) ? bruto.tipo : 'erro';
    const app = ctx.app, versao = String(ctx.versao || '').slice(0, 20);
    return {
      app, versao, tipo, mensagem, origem: origem.slice(0, TAM.origem), pilha,
      navegador: navegador(ctx.ua), assinatura: assinatura(app, versao, mensagem, origem), quando: ctx.agora || Date.now(),
    };
  }

  // Regras de envio: mesmo erro no máximo 1×/dia; no máximo LIMITE_DIA envios por dia
  function podeEnviar(reg, enviados, agora) {
    const recentes = Object.values(enviados || {}).filter((t) => agora - t < UM_DIA).length;
    if (recentes >= LIMITE_DIA) return false;
    const ultimo = enviados && enviados[reg.assinatura];
    return !(ultimo && agora - ultimo < UM_DIA);
  }

  // ───────────── NAVEGADOR ─────────────
  function iniciar(win) {
    const doc = win.document;
    if (!doc || win.StkErros) return;
    const script = doc.currentScript;
    const APP = String((script && script.dataset.app) || 'APPS').toUpperCase().replace(/[^A-Z]/g, '');
    const K = { lista: `stk-erros:${APP}:lista`, enviados: `stk-erros:${APP}:enviados`, testador: 'stk-erros:testador' };
    const ler = (k, padrao) => { try { const v = win.localStorage.getItem(k); return v == null ? padrao : JSON.parse(v); } catch (_) { return padrao; } };
    const gravar = (k, v) => { try { win.localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
    const versao = () => (doc.documentElement.dataset.vaultVersion || doc.documentElement.dataset.version || '');
    const testador = () => ler(K.testador, false) === true;
    let avisouNestaSessao = false, capturando = false;

    function registrar(bruto) {
      if (capturando) return null;            // erro dentro do próprio log não entra em laço
      capturando = true;
      try {
        const reg = montar(bruto, { app: APP, versao: versao(), ua: win.navigator && win.navigator.userAgent });
        const lista = ler(K.lista, []);
        const igual = lista.find((r) => r.assinatura === reg.assinatura);
        if (igual) { igual.vezes = (igual.vezes || 1) + 1; igual.quando = reg.quando; }
        else lista.unshift({ ...reg, vezes: 1, enviado: false });
        gravar(K.lista, lista.slice(0, LIMITE_LOCAL));
        if (testador()) enviar(reg);
        else avisar(reg);
        return reg;
      } catch (_) { return null; } finally { capturando = false; }
    }

    async function enviar(reg) {
      const agora = Date.now();
      const enviados = ler(K.enviados, {});
      if (!podeEnviar(reg, enviados, agora)) return false;
      if (!win.Feedback || typeof win.Feedback.relatarErro !== 'function') return false;
      try {
        await win.Feedback.relatarErro(reg);
        enviados[reg.assinatura] = agora;
        for (const k of Object.keys(enviados)) if (agora - enviados[k] > UM_DIA) delete enviados[k];
        gravar(K.enviados, enviados);
        const lista = ler(K.lista, []);
        const item = lista.find((r) => r.assinatura === reg.assinatura);
        if (item) { item.enviado = true; gravar(K.lista, lista); }
        return true;
      } catch (_) { return false; }
    }

    async function enviarPendentes() {
      let n = 0;
      for (const r of ler(K.lista, []).filter((x) => !x.enviado)) if (await enviar(r)) n++;
      return n;
    }

    // Captura
    win.addEventListener('error', (e) => {
      if (e.target && e.target !== win) return;  // falha ao carregar imagem/script não é erro de código
      registrar({ tipo: 'erro', erro: e.error, mensagem: e.message, arquivo: e.filename, linha: e.lineno, coluna: e.colno });
    });
    win.addEventListener('unhandledrejection', (e) => {
      const r = e.reason;
      registrar({ tipo: 'promessa', erro: r instanceof Error ? r : null, mensagem: r instanceof Error ? '' : 'Promessa rejeitada: ' + String(r) });
    });
    if (win.console && typeof win.console.error === 'function') {
      const original = win.console.error.bind(win.console);
      win.console.error = function (...args) {
        original(...args);
        const err = args.find((a) => a instanceof Error);
        const texto = args.filter((a) => typeof a === 'string').join(' ');
        registrar({ tipo: 'console', erro: err || null, mensagem: err ? '' : texto });
      };
    }

    // ───── Interface ─────
    const css = () => {
      if (doc.getElementById('dz-style') || doc.querySelector('link[href*="apoio.css"]')) return;
      const l = doc.createElement('link'); l.rel = 'stylesheet'; l.id = 'dz-style';
      l.href = new URL('apoio.css', (script && script.src) || win.location.href).href; doc.head.appendChild(l);
    };
    const el = (tag, cls, txt) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

    function avisar(reg) {
      if (avisouNestaSessao || !win.Feedback) return;
      const enviados = ler(K.enviados, {});
      if (!podeEnviar(reg, enviados, Date.now())) return;
      avisouNestaSessao = true;
      const mostrar = () => {
        css();
        const t = el('div', 'dz-root dz-toast');
        t.setAttribute('role', 'status');
        t.append(el('span', 'dz-toast-txt', 'Ocorreu um erro no app. Enviar um relatório técnico? Não inclui seus dados.'));
        const bEnviar = el('button', 'dz-toast-btn', 'Enviar'); bEnviar.type = 'button';
        const bFechar = el('button', 'dz-toast-x', '×'); bFechar.type = 'button'; bFechar.setAttribute('aria-label', 'Fechar');
        bEnviar.onclick = async () => { bEnviar.disabled = true; const ok = await enviar(reg); t.querySelector('.dz-toast-txt').textContent = ok ? 'Relatório enviado. Obrigado!' : 'Não foi possível enviar agora.'; bEnviar.remove(); setTimeout(() => t.remove(), 3000); };
        bFechar.onclick = () => t.remove();
        t.append(bEnviar, bFechar);
        doc.body.appendChild(t);
        setTimeout(() => t.remove(), 15000);
      };
      if (doc.body) mostrar(); else doc.addEventListener('DOMContentLoaded', mostrar);
    }

    function quando(ms) {
      const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
      return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    function abrirPainel() {
      css();
      const ov = el('div', 'dz-root dz-overlay');
      const sh = el('div', 'dz-sheet'); sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true'); sh.setAttribute('aria-label', 'Relatórios de erro');
      const fechar = () => { ov.remove(); doc.removeEventListener('keydown', esc); };
      const esc = (e) => { if (e.key === 'Escape') fechar(); };
      ov.addEventListener('click', (e) => { if (e.target === ov) fechar(); });
      doc.addEventListener('keydown', esc);

      function desenhar(status) {
        const lista = ler(K.lista, []), ligado = testador();
        sh.replaceChildren();
        const head = el('div', 'dz-head'); head.append(el('strong', 'dz-card-title', 'Relatórios de erro'));
        const x = el('button', 'dz-close', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Fechar'); x.onclick = fechar; head.append(x);
        sh.append(el('div', 'dz-grip'), head,
          el('p', 'dz-text', 'Erros técnicos deste app, guardados só neste aparelho. O relatório leva app, versão, mensagem técnica limpa, arquivo e linha, navegador e data. Nunca leva valores, lançamentos, PIN ou textos digitados.'));

        const sw = el('label', 'dz-err-switch');
        const chk = el('input'); chk.type = 'checkbox'; chk.checked = ligado;
        chk.onchange = () => { gravar(K.testador, chk.checked); if (chk.checked) enviarPendentes().then((n) => desenhar(n ? n + ' relatório(s) enviado(s).' : '')); else desenhar(); };
        sw.append(chk, el('span', '', 'Modo testador: enviar relatórios automaticamente (vale para todos os apps deste aparelho)'));
        sh.append(sw);

        if (!lista.length) sh.append(el('p', 'dz-err-vazio', 'Nenhum erro registrado.'));
        else {
          const ul = el('ul', 'dz-err-lista');
          for (const r of lista.slice(0, 20)) {
            const li = el('li', 'dz-err-item');
            li.append(el('div', 'dz-err-msg', r.mensagem),
              el('div', 'dz-err-meta', `${quando(r.quando)} · v${r.versao || '?'} · ${r.origem || 'sem origem'}${r.vezes > 1 ? ' · ' + r.vezes + '×' : ''} · ${r.enviado ? 'enviado' : 'não enviado'}`));
            ul.append(li);
          }
          sh.append(ul);
        }
        const st = el('div', 'dz-status' + (status ? ' ok' : ''), status || '');
        const pend = lista.filter((r) => !r.enviado).length;
        const bEnv = el('button', 'dz-btn', pend ? `Enviar ${pend} relatório(s) agora` : 'Nada para enviar'); bEnv.type = 'button'; bEnv.disabled = !pend || !win.Feedback;
        bEnv.onclick = async () => { bEnv.disabled = true; const n = await enviarPendentes(); desenhar(n ? n + ' relatório(s) enviado(s).' : 'Nada enviado (sem conexão ou limite diário).'); };
        const linha = el('div', 'dz-err-acoes');
        const bCop = el('button', 'dz-chip', 'Copiar'); bCop.type = 'button';
        bCop.onclick = async () => {
          const txt = lista.map((r) => `[${quando(r.quando)}] ${r.app} v${r.versao} ${r.tipo}: ${r.mensagem}\n  ${r.origem}${r.pilha ? '\n  ' + r.pilha.replace(/\n/g, '\n  ') : ''}`).join('\n\n') || 'Nenhum erro registrado.';
          try { await win.navigator.clipboard.writeText(txt); st.textContent = 'Copiado.'; st.className = 'dz-status ok'; } catch (_) { st.textContent = 'Não foi possível copiar.'; st.className = 'dz-status err'; }
        };
        const bLimpar = el('button', 'dz-chip', 'Limpar lista'); bLimpar.type = 'button';
        bLimpar.onclick = () => { gravar(K.lista, []); desenhar('Lista limpa.'); };
        linha.append(bCop, bLimpar);
        sh.append(bEnv, linha, st);
      }
      desenhar();
      ov.append(sh); doc.body.appendChild(ov);
      const f = sh.querySelector('input'); if (f) f.focus();
    }

    // Seção em Configurações (kit de segurança), depois do PIN
    doc.addEventListener('DOMContentLoaded', () => {
      if (!win.FinancSettings || (script && script.dataset.menu === 'false')) return;
      Promise.resolve(win.vaultReady).then(() => win.FinancSettings.addSection({
        title: 'Relatórios de erro',
        rows: [{ icon: 'alert', label: 'Erros do app', description: 'Ver, copiar ou enviar · modo testador', onClick: abrirPainel }],
      }));
    });

    win.StkErros = { registrar: (erro, contexto) => registrar({ tipo: 'console', erro: erro instanceof Error ? erro : null, mensagem: contexto || String(erro) }), abrir: abrirPainel, enviarPendentes, lista: () => ler(K.lista, []) };
  }

  return { limparMensagem, limparArquivo, limparPilha, navegador, assinatura, montar, podeEnviar, iniciar, LIMITE_DIA, LIMITE_LOCAL };
});
