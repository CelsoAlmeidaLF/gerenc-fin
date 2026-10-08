/*!
 * stk-pkg-feedback.js — adaptador de avaliações e sugestões
 * Backend atual: Firebase Firestore.
 * Para migrar (self-hosted), reescreva só as 3 funções de BACKEND mantendo a mesma interface:
 *   Feedback.avaliar(app, nota)            → Promise<void>
 *   Feedback.sugerir(app, {tipo, texto, email}) → Promise<void>
 *   Feedback.media(app)                    → Promise<{media:number, total:number}>
 *   Feedback.relatarErro(registro)         → Promise<void>  (registro já limpo pelo stk-pkg-erros.js)
 */
(function () {
  'use strict';

  // ───────────── CONFIGURAÇÃO ─────────────
  // Copie do console do Firebase: Configurações do projeto → Seus apps → SDK (config)
  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyCQx8kJyXEReASiQMI4a5bT5NNWgtBmJpM',
    authDomain: 'systekna-feedback.firebaseapp.com',
    projectId: 'systekna-feedback',
    appId: '1:870927975015:web:0576bd5e3cdd8d067d8ac2',
  };
  // App Check com reCAPTCHA Enterprise (bloqueia robôs). Chave de site do projeto; deixe '' para desativar.
  // Domínios da chave: celsoalmeidalf.github.io, financ-apps.github.io, localhost.
  const RECAPTCHA_SITE_KEY = '6LehydgtAAAAAOqkwKOQPzg2m0CZwYTRZSXPeyyx';
  const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';

  const APPS = ['CRIPTO', 'LIVROCAIXA', 'CAMBIO', 'DESPESAS', 'LAUNCHER', 'TAXOMETRO', 'INVEST'];
  const TIPOS = ['sugestao', 'problema', 'elogio'];

  // ───────────── BACKEND (Firebase) ─────────────
  let fbPromise = null;
  function firebase() {
    if (!fbPromise) {
      fbPromise = (async () => {
        const { initializeApp, getApps } = await import(SDK + 'firebase-app.js');
        const fs = await import(SDK + 'firebase-firestore.js');
        const app = getApps().find((a) => a.name === 'feedback') || initializeApp(FIREBASE_CONFIG, 'feedback');
        if (RECAPTCHA_SITE_KEY) {
          const ac = await import(SDK + 'firebase-app-check.js');
          ac.initializeAppCheck(app, {
            provider: new ac.ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY),
            isTokenAutoRefreshEnabled: true,
          });
        }
        return { fs, db: fs.getFirestore(app) };
      })().catch((e) => { fbPromise = null; throw e; });
    }
    return fbPromise;
  }

  async function backendAvaliar(app, nota) {
    const { fs, db } = await firebase();
    await fs.addDoc(fs.collection(db, 'avaliacoes'), { app, nota, criadoEm: fs.serverTimestamp() });
  }

  async function backendSugerir(app, dados) {
    const { fs, db } = await firebase();
    const doc = { app, tipo: dados.tipo, texto: dados.texto, criadoEm: fs.serverTimestamp() };
    if (dados.email) doc.email = dados.email;
    await fs.addDoc(fs.collection(db, 'sugestoes'), doc);
  }

  async function backendMedia(app) {
    const { fs, db } = await firebase();
    const q = fs.query(fs.collection(db, 'avaliacoes'), fs.where('app', '==', app));
    const snap = await fs.getAggregateFromServer(q, { media: fs.average('nota'), total: fs.count() });
    const d = snap.data();
    return { media: d.media || 0, total: d.total || 0 };
  }

  // Relatório técnico de erro: só os campos limpos; o horário vem do servidor
  const CAMPOS_ERRO = ['app', 'versao', 'tipo', 'mensagem', 'origem', 'pilha', 'navegador', 'assinatura'];
  async function backendRelatarErro(reg) {
    const { fs, db } = await firebase();
    const doc = { criadoEm: fs.serverTimestamp() };
    for (const k of CAMPOS_ERRO) doc[k] = String(reg[k] == null ? '' : reg[k]);
    await fs.addDoc(fs.collection(db, 'erros'), doc);
  }

  // ───────────── VALIDAÇÃO + LIMITES LOCAIS ─────────────
  const chave = (app, k) => `apoio:${app}:${k}`;
  const ler = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  function checarApp(app) {
    if (!APPS.includes(app)) throw new Error('App não cadastrado: ' + app);
  }

  async function avaliar(app, nota) {
    checarApp(app);
    nota = Math.round(Number(nota));
    if (!(nota >= 1 && nota <= 5)) throw new Error('Escolha de 1 a 5 estrelas.');
    if (ler(chave(app, 'nota'))) throw new Error('Este aparelho já avaliou este app.');
    await backendAvaliar(app, nota);
    gravar(chave(app, 'nota'), String(nota));
  }

  async function sugerir(app, { tipo, texto, email, armadilha }) {
    checarApp(app);
    if (armadilha) return; // campo invisível preenchido → robô; finge sucesso
    texto = String(texto || '').trim();
    email = String(email || '').trim();
    if (!TIPOS.includes(tipo)) throw new Error('Escolha o tipo da mensagem.');
    if (texto.length < 3) throw new Error('Escreva a mensagem antes de enviar.');
    if (texto.length > 1000) throw new Error('A mensagem passou de 1000 caracteres.');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('O e-mail não parece válido.');
    if (email.length > 120) throw new Error('E-mail longo demais.');
    const ultimo = Number(ler(chave(app, 'ultimaSugestao')) || 0);
    if (Date.now() - ultimo < 60000) throw new Error('Aguarde um minuto para enviar outra mensagem.');
    await backendSugerir(app, { tipo, texto, email });
    gravar(chave(app, 'ultimaSugestao'), String(Date.now()));
  }

  function minhaNota(app) {
    return Number(ler(chave(app, 'nota')) || 0);
  }

  async function relatarErro(reg) {
    if (!reg || !APPS.includes(reg.app)) throw new Error('App não cadastrado.');
    await backendRelatarErro(reg);
  }

  window.Feedback = { avaliar, sugerir, media: backendMedia, minhaNota, relatarErro, TIPOS };
})();
