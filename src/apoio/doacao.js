/*!
 * doacao.js v2 — painel Apoiar · Avaliar · Sugerir para os apps Systekna
 * Padrão visual: Design System — Registro Evolutivo
 *
 * Uso (dentro de cada app):
 *   <link rel="stylesheet" href="../shared/apoio.css" id="dz-style">  ← opcional: evita piscar sem estilo
 *   <script src="../shared/feedback.js"></script>              ← opcional: ativa Avaliar e Sugerir
 *   <script src="../shared/doacao.js" data-app="LIVROCAIXA"></script>
 *
 *   Doacao.abrir()           → Apoiar (Pix)
 *   Doacao.abrir('btc')      → Apoiar (Bitcoin)
 *   Doacao.abrir('avaliar')  → Avaliar
 *   Doacao.abrir('sugerir')  → Sugerir
 *   Doacao.embutir('#div', 'avaliar' | 'sugerir' | 'apoiar') → seção direto na página
 *
 * data-flutuante="false" → não cria o botão flutuante.
 * data-menu="false"      → não entra no menu do kit de segurança (FinancSettings).
 */
(function () {
  'use strict';

  // ───────────── CONFIGURAÇÃO ─────────────
  const CONFIG = {
    pix: {
      chave: '4813ea9a-e8cc-43d1-9c2b-6e1092018369',
      nome: 'CELSO DE ALMEIDA LEITE F', // máx. 25, sem acento
      cidade: 'SAO PAULO',              // máx. 15, sem acento
    },
    btc: { endereco: 'bc1q4m5dr4a0mqfgdzjfvacz5cwdjddz5xnyt2qx6m' },
    valores: [5, 10, 20, 50],
  };

  const script = document.currentScript;
  const APP_ID = limparTxid((script && script.dataset.app) || 'APPS');
  const FLUTUANTE = !(script && script.dataset.flutuante === 'false');
  // Biblioteca de QR servida do próprio repositório (integridade + funciona offline)
  const QR_LIB = new URL('qrcode.js', (script && script.src) || location.href).href;

  // ───────────── PIX (BR Code / EMV) ─────────────
  function semAcento(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  }
  function limparTxid(s) {
    return semAcento(String(s)).replace(/[^A-Z0-9]/g, '').slice(0, 25) || '***';
  }
  const campo = (id, v) => id + String(v.length).padStart(2, '0') + v;
  function crc16(str) {
    let crc = 0xffff;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j++) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }
  function gerarPix(valor) {
    const { chave, nome, cidade } = CONFIG.pix;
    const p =
      campo('00', '01') +
      campo('26', campo('00', 'br.gov.bcb.pix') + campo('01', chave)) +
      campo('52', '0000') + campo('53', '986') +
      (valor > 0 ? campo('54', valor.toFixed(2)) : '') +
      campo('58', 'BR') +
      campo('59', semAcento(nome).slice(0, 25)) +
      campo('60', semAcento(cidade).slice(0, 15)) +
      campo('62', campo('05', APP_ID)) + '6304';
    return p + crc16(p);
  }

  // ───────────── QR CODE ─────────────
  let qrPromise = null;
  function carregarQr() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (!qrPromise) {
      qrPromise = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = QR_LIB;
        s.onload = () => res(window.qrcode);
        s.onerror = () => { qrPromise = null; rej(new Error('qr')); };
        document.head.appendChild(s);
      });
    }
    return qrPromise;
  }
  function desenharQr(alvo, texto) {
    alvo.innerHTML = '<span class="dz-qr-msg">gerando QR…</span>';
    carregarQr()
      .then((qrcode) => {
        const qr = qrcode(0, 'M');
        qr.addData(texto);
        qr.make();
        alvo.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      })
      .catch(() => { alvo.innerHTML = '<span class="dz-qr-msg">QR indisponível. Use o botão copiar abaixo.</span>'; });
  }

  function copiar(texto) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(texto);
    const t = document.createElement('textarea');
    t.value = texto;
    t.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(t);
    t.select();
    try { document.execCommand('copy'); } finally { t.remove(); }
    return Promise.resolve();
  }

  // ───────────── ESTILO ─────────────

  // CSS em arquivo separado (apoio.css, na mesma pasta deste script)
  const CSS_URL = new URL('apoio.css', (script && script.src) || location.href).href;
  function injetarEstilo() {
    if (document.getElementById('dz-style')) return;
    const l = document.createElement('link');
    l.id = 'dz-style';
    l.rel = 'stylesheet';
    l.href = CSS_URL;
    document.head.appendChild(l);
    const temFonte = [...document.querySelectorAll('link[href*="fonts.googleapis"]')].some((x) => /Space\+Grotesk/.test(x.href));
    if (!temFonte) {
      const f = document.createElement('link');
      f.rel = 'stylesheet';
      f.href = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap';
      document.head.appendChild(f);
    }
  }

  // ───────────── INTERFACE ─────────────
  const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  // "15,50", "15.50", "1.000,00", "1,000.50" → número; negativo ou inválido → 0 (valor livre)
  function lerValor(txt) {
    let s = String(txt).replace(/[^\d,.-]/g, '');
    if (s.includes('-')) return 0;
    const dec = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
    // separador seguido de 1–2 dígitos no fim = decimal; o resto é milhar
    if (dec >= 0 && /^\d{1,2}$/.test(s.slice(dec + 1))) s = s.slice(0, dec).replace(/[,.]/g, '') + '.' + s.slice(dec + 1);
    else s = s.replace(/[,.]/g, '');
    const n = parseFloat(s);
    return n > 0 && n < 1e6 ? Math.round(n * 100) / 100 : 0;
  }
  const grupos = (s) => s.match(/.{1,4}/g).join(' ');
  const ROTULOS = ['', 'Ruim', 'Fraco', 'Ok', 'Bom', 'Excelente'];
  const TIPOS = [['sugestao', 'Sugestão'], ['problema', 'Problema'], ['elogio', 'Elogio']];
  const end = CONFIG.btc.endereco;
  let aberto = null;

  // ── HTML das seções (reutilizado no painel e no modo embutido)
  const htmlApoiar = () => `
    <p class="dz-text">Os apps são gratuitos. Se algum deles te ajuda, uma doação mantém o desenvolvimento.</p>
    <div class="dz-seg" role="tablist">
      <button role="tab" data-moeda="pix" aria-selected="true">Pix</button>
      <button role="tab" data-moeda="btc" aria-selected="false">Bitcoin</button>
    </div>
    <div data-moeda-painel="pix">
      <span class="dz-label">Valor</span>
      <div class="dz-chips" data-grupo="valor">
        ${CONFIG.valores.map((v) => `<button class="dz-chip" data-v="${v}" aria-pressed="false">${brl(v)}</button>`).join('')}
        <button class="dz-chip" data-v="outro" aria-pressed="false">Outro</button>
        <button class="dz-chip" data-v="0" aria-pressed="true">Livre</button>
      </div>
      <div class="dz-field dz-hidden" data-outro><input type="text" inputmode="decimal" placeholder="R$ 0,00" aria-label="Outro valor"></div>
      <div class="dz-qr" data-qr="pix"></div>
      <button class="dz-btn" data-copiar="pix">Copiar código Pix</button>
      <div class="dz-meta" data-meta="pix"></div>
    </div>
    <div data-moeda-painel="btc" class="dz-hidden">
      <div class="dz-qr" data-qr="btc"></div>
      <div class="dz-addr">${grupos(end)}</div>
      <p class="dz-note">Envie só BTC pela rede Bitcoin. Na carteira, confira se o endereço começa com ${end.slice(0, 8)} e termina com ${end.slice(-4)}.</p>
      <button class="dz-btn" data-copiar="btc">Copiar endereço</button>
    </div>`;

  const htmlAvaliar = () => `
    <div class="dz-avg" data-avg><span>carregando média…</span></div>
    <span class="dz-label" style="text-align:center">Sua nota para este app</span>
    <div class="dz-stars" role="radiogroup" aria-label="Nota de 1 a 5">
      ${[1, 2, 3, 4, 5].map((n) => `<button class="dz-star" role="radio" aria-checked="false" aria-label="${n} de 5" data-n="${n}">★</button>`).join('')}
    </div>
    <div class="dz-star-label" data-star-label></div>
    <button class="dz-btn" data-enviar="avaliar" disabled>Enviar avaliação</button>
    <div class="dz-status" data-status="avaliar"></div>`;

  const htmlSugerir = () => `
    <p class="dz-text">Ideia, problema ou elogio: tudo chega direto para quem desenvolve os apps.</p>
    <span class="dz-label">Tipo</span>
    <div class="dz-chips" data-grupo="tipo">
      ${TIPOS.map(([v, r], i) => `<button class="dz-chip" data-tipo="${v}" aria-pressed="${i === 0}">${r}</button>`).join('')}
    </div>
    <div class="dz-field">
      <textarea maxlength="1000" placeholder="Escreva sua mensagem" aria-label="Mensagem" data-texto></textarea>
      <div class="dz-hint"><span></span><span data-contador>0/1000</span></div>
    </div>
    <div class="dz-field">
      <input type="email" placeholder="seu@email.com (opcional)" aria-label="E-mail opcional" autocomplete="email" data-email>
      <div class="dz-hint"><span>Opcional. Usado só para responder você.</span></div>
    </div>
    <input class="dz-trap" type="text" name="site" tabindex="-1" autocomplete="off" aria-hidden="true" data-trap>
    <button class="dz-btn" data-enviar="sugerir">Enviar mensagem</button>
    <div class="dz-status" data-status="sugerir"></div>`;

  // ── comportamento de cada seção (recebe o elemento que a contém)
  const escopo = (el) => [(s) => el.querySelector(s), (s) => [...el.querySelectorAll(s)]];
  function status(el, msg, tipo) {
    el.textContent = msg;
    el.className = 'dz-status' + (tipo ? ' ' + tipo : '');
  }

  function ligarApoiar(el) {
    const [$, $$] = escopo(el);
    let valor = 0, codigoPix = '', btcDesenhado = false;
    function atualizarPix() {
      codigoPix = gerarPix(valor);
      desenharQr($('[data-qr="pix"]'), codigoPix);
      $('[data-meta="pix"]').textContent = valor > 0 ? brl(valor) : 'Você define o valor no app do banco';
    }
    function mudarMoeda(m) {
      $$('[data-moeda]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.moeda === m)));
      $$('[data-moeda-painel]').forEach((p) => p.classList.toggle('dz-hidden', p.dataset.moedaPainel !== m));
      if (m === 'btc' && !btcDesenhado) { desenharQr($('[data-qr="btc"]'), 'bitcoin:' + end); btcDesenhado = true; }
    }
    $$('[data-moeda]').forEach((b) => b.addEventListener('click', () => mudarMoeda(b.dataset.moeda)));
    $$('[data-grupo="valor"] .dz-chip').forEach((c) =>
      c.addEventListener('click', () => {
        $$('[data-grupo="valor"] .dz-chip').forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
        const outro = c.dataset.v === 'outro';
        $('[data-outro]').classList.toggle('dz-hidden', !outro);
        // "Outro" usa o que já está digitado (vazio → valor livre), nunca o chip anterior
        valor = outro ? lerValor($('[data-outro] input').value) : Number(c.dataset.v);
        if (outro) $('[data-outro] input').focus();
        atualizarPix();
      })
    );
    let tOutro;
    const inputOutro = $('[data-outro] input');
    inputOutro.addEventListener('input', () => {
      clearTimeout(tOutro);
      tOutro = setTimeout(() => { valor = lerValor(inputOutro.value); atualizarPix(); }, 350);
    });
    $$('[data-copiar]').forEach((b) =>
      b.addEventListener('click', () => {
        const txt = b.dataset.copiar === 'pix' ? codigoPix : end;
        const orig = b.textContent;
        copiar(txt).then(() => {
          b.textContent = 'Copiado';
          b.classList.add('done');
          setTimeout(() => { b.textContent = orig; b.classList.remove('done'); }, 1800);
        });
      })
    );
    atualizarPix();
    return { mudarMoeda };
  }

  function ligarAvaliar(el) {
    const [$, $$] = escopo(el);
    const st = $('[data-status="avaliar"]');
    const enviar = $('[data-enviar="avaliar"]');
    function carregarMedia() {
      const box = $('[data-avg]');
      window.Feedback.media(APP_ID)
        .then(({ media, total }) => {
          box.innerHTML = total
            ? `<b>${media.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</b><span>de 5 · ${total} ${total === 1 ? 'avaliação' : 'avaliações'}</span>`
            : '<span>Ainda sem avaliações. A sua pode ser a primeira.</span>';
        })
        .catch(() => { box.innerHTML = '<span>Média indisponível agora. Verifique a conexão.</span>'; });
    }
    let nota = window.Feedback.minhaNota(APP_ID);
    let travado = nota > 0;
    const pintar = (n) => {
      $$('.dz-star').forEach((s) => {
        const v = Number(s.dataset.n);
        s.classList.toggle('on', v <= n);
        s.setAttribute('aria-checked', String(v === n));
      });
      $('[data-star-label]').textContent = ROTULOS[n] || '';
    };
    function travar(msg) {
      travado = true;
      $('.dz-stars').classList.add('lock');
      enviar.classList.add('dz-hidden');
      status(st, msg, 'ok');
    }
    pintar(nota);
    if (travado) travar(`Você deu ${nota} ${nota === 1 ? 'estrela' : 'estrelas'} para este app. Obrigado.`);
    $$('.dz-star').forEach((s) => {
      s.addEventListener('click', () => { if (travado) return; nota = Number(s.dataset.n); pintar(nota); enviar.disabled = false; });
      s.addEventListener('mouseenter', () => { if (!travado) pintar(Number(s.dataset.n)); });
    });
    $('.dz-stars').addEventListener('mouseleave', () => pintar(nota));
    enviar.addEventListener('click', async () => {
      enviar.disabled = true;
      status(st, 'Enviando…');
      try {
        await window.Feedback.avaliar(APP_ID, nota);
        travar('Avaliação enviada. Obrigado.');
        carregarMedia();
      } catch (err) {
        enviar.disabled = false;
        status(st, err.message.includes('já avaliou') ? err.message : 'Não foi possível enviar. Verifique a conexão e tente de novo.', 'err');
      }
    });
    return { carregarMedia };
  }

  function ligarSugerir(el) {
    const [$, $$] = escopo(el);
    const st = $('[data-status="sugerir"]');
    let tipo = 'sugestao';
    $$('[data-grupo="tipo"] .dz-chip').forEach((c) =>
      c.addEventListener('click', () => {
        tipo = c.dataset.tipo;
        $$('[data-grupo="tipo"] .dz-chip').forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
      })
    );
    const txt = $('[data-texto]');
    txt.addEventListener('input', () => { $('[data-contador]').textContent = `${txt.value.length}/1000`; });
    const b = $('[data-enviar="sugerir"]');
    b.addEventListener('click', async () => {
      b.disabled = true;
      status(st, 'Enviando…');
      try {
        await window.Feedback.sugerir(APP_ID, { tipo, texto: txt.value, email: $('[data-email]').value, armadilha: $('[data-trap]').value });
        txt.value = '';
        $('[data-email]').value = '';
        $('[data-contador]').textContent = '0/1000';
        status(st, 'Mensagem enviada. Obrigado.', 'ok');
      } catch (err) {
        const local = /Escolha|Escreva|passou|e-mail|E-mail|Aguarde/.test(err.message);
        status(st, local ? err.message : 'Não foi possível enviar. Verifique a conexão e tente de novo.', 'err');
      } finally {
        b.disabled = false;
      }
    });
  }

  // ── painel (modal)
  function abrir(aba) {
    if (aberto) return;
    injetarEstilo();
    const temFeedback = !!window.Feedback;
    const root = document.createElement('div');
    root.className = 'dz-root dz-overlay';
    root.innerHTML = `
      <div class="dz-sheet" role="dialog" aria-modal="true" aria-label="Apoiar, avaliar ou sugerir">
        <div class="dz-grip"></div>
        <div class="dz-head">
          <div class="dz-tabs" role="tablist">
            <button role="tab" data-tab="apoiar" aria-selected="true">Apoiar</button>
            ${temFeedback ? `<button role="tab" data-tab="avaliar" aria-selected="false">Avaliar</button>
            <button role="tab" data-tab="sugerir" aria-selected="false">Sugerir</button>` : ''}
          </div>
          <button class="dz-close" aria-label="Fechar">×</button>
        </div>
        <section data-painel="apoiar">${htmlApoiar()}</section>
        ${temFeedback ? `<section data-painel="avaliar" class="dz-hidden">${htmlAvaliar()}</section>
        <section data-painel="sugerir" class="dz-hidden">${htmlSugerir()}</section>` : ''}
      </div>`;
    document.body.appendChild(root);
    aberto = root;
    const [$, $$] = escopo(root);

    const apoio = ligarApoiar($('[data-painel="apoiar"]'));
    let aval = null;
    if (temFeedback) {
      aval = ligarAvaliar($('[data-painel="avaliar"]'));
      ligarSugerir($('[data-painel="sugerir"]'));
    }
    let mediaCarregada = false;
    function mudarTab(t) {
      $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
      $$('[data-painel]').forEach((p) => p.classList.toggle('dz-hidden', p.dataset.painel !== t));
      if (t === 'avaliar' && aval && !mediaCarregada) { mediaCarregada = true; aval.carregarMedia(); }
    }
    $$('[data-tab]').forEach((b) => b.addEventListener('click', () => mudarTab(b.dataset.tab)));

    function fechar() { document.removeEventListener('keydown', esc); root.remove(); aberto = null; }
    const esc = (e) => e.key === 'Escape' && fechar();
    document.addEventListener('keydown', esc);
    $('.dz-close').addEventListener('click', fechar);
    root.addEventListener('click', (e) => { if (e.target === root) fechar(); });

    if (aba === 'btc') apoio.mudarMoeda('btc');
    if (temFeedback && (aba === 'avaliar' || aba === 'sugerir')) mudarTab(aba);
    $('.dz-close').focus();
  }

  // ── modo embutido: coloca uma seção direto na página
  // Doacao.embutir('#meu-div', 'avaliar' | 'sugerir' | 'apoiar')
  function embutir(alvo, secao) {
    injetarEstilo();
    const el = typeof alvo === 'string' ? document.querySelector(alvo) : alvo;
    if (!el) throw new Error('Doacao.embutir: elemento não encontrado');
    if (secao !== 'apoiar' && !window.Feedback) throw new Error('Doacao.embutir: carregue feedback.js antes');
    // Se os campos já estão escritos no HTML, só liga o comportamento neles
    const existente = el.matches('.dz-card') ? el : el.querySelector('.dz-card');
    if (existente) {
      if (secao === 'apoiar') ligarApoiar(existente);
      if (secao === 'avaliar') ligarAvaliar(existente).carregarMedia();
      if (secao === 'sugerir') ligarSugerir(existente);
      return existente;
    }
    const titulos = { apoiar: 'Apoiar o projeto', avaliar: 'Avaliar este app', sugerir: 'Enviar sugestão' };
    const html = { apoiar: htmlApoiar, avaliar: htmlAvaliar, sugerir: htmlSugerir }[secao];
    if (!html) throw new Error('Doacao.embutir: seção inválida');
    const card = document.createElement('section');
    card.className = 'dz-root dz-card';
    card.innerHTML = `<h3 class="dz-card-title">${titulos[secao]}</h3>${html()}`;
    el.appendChild(card);
    if (secao === 'apoiar') ligarApoiar(card);
    if (secao === 'avaliar') ligarAvaliar(card).carregarMedia();
    if (secao === 'sugerir') ligarSugerir(card);
    return card;
  }

  function criarBotao() {
    injetarEstilo();
    const b = document.createElement('button');
    b.className = 'dz-root dz-fab';
    b.type = 'button';
    b.textContent = '☕ Apoiar';
    b.addEventListener('click', () => abrir());
    document.body.appendChild(b);
  }

  window.Doacao = { abrir, embutir, gerarPix, config: CONFIG };

  // Nos apps com o kit de segurança: entra como seção no menu de 3 pontos e em Configurações.
  // Carregue depois do app.js: os apps registram as seções deles após `await vaultReady`,
  // e esperar a mesma promessa aqui deixa esta seção por último. data-menu="false" desativa.
  if (window.FinancSettings && !(script && script.dataset.menu === 'false')) {
    const linhas = [{ icon: 'heart', label: 'Apoiar com Pix ou Bitcoin', description: 'Os apps são gratuitos', onClick: () => abrir() }];
    if (window.Feedback) {
      linhas.push({ icon: 'star', label: 'Avaliar este app', description: 'De 1 a 5 estrelas', onClick: () => abrir('avaliar') });
      linhas.push({ icon: 'message-square', label: 'Enviar sugestão', description: 'Ideia, problema ou elogio', onClick: () => abrir('sugerir') });
    }
    Promise.resolve(window.vaultReady).then(() => window.FinancSettings.addSection({ title: 'Apoiar o projeto', rows: linhas }));
  }

  if (FLUTUANTE) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', criarBotao);
    else criarBotao();
  }
})();
