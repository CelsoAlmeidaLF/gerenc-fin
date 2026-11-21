/*!
 * stk-pkt-feedback.js — adaptador de avaliações e sugestões
 * Backend atual: Firebase Firestore, pela ponte (stk-pkt-ponte.js, iframe em systekna-ponte.web.app).
 * Para migrar (self-hosted), reescreva só as 3 funções de BACKEND mantendo a mesma interface:
 *   Feedback.avaliar(app, nota)            → Promise<void>
 *   Feedback.sugerir(app, {tipo, texto, email}) → Promise<void>
 *   Feedback.media(app)                    → Promise<{media:number, total:number}>
 *   Feedback.relatarErro(registro)         → Promise<void>  (registro já limpo pelo stk-pkt-erros.js)
 */
(function () {
  'use strict';

  // ───────────── BACKEND (ponte do Firebase) ─────────────
  // O SDK do Firebase (App Check + Firestore) roda na ponte, num endereço só dela (stk-pkt-ponte): o app não carrega
  // código do Google perto do cofre aberto. Requer stk-pkt-ponte.js carregado antes deste arquivo.
  const APPS = ['CRIPTO', 'LIVROCAIXA', 'CAMBIO', 'DESPESAS', 'LAUNCHER', 'TAXOMETRO', 'INVEST', 'FORCA', 'SMART', 'AGENDA', 'BARGESTAO', 'MULTICM'];
  const TIPOS = ['sugestao', 'problema', 'elogio'];
  const ponte = () => {
    if (!window.SystekPonte) throw new Error('Serviço de avaliações indisponível nesta página.');
    return window.SystekPonte;
  };
  const backendAvaliar = (app, nota) => ponte().chamar('avaliar', { app, nota });
  const backendSugerir = (app, dados) => ponte().chamar('sugerir', { app, tipo: dados.tipo, texto: dados.texto, email: dados.email || '' });
  const backendMedia = (app) => ponte().chamar('media', { app });
  // Relatório técnico de erro: só os campos limpos; o horário vem do servidor (na ponte)
  const CAMPOS_ERRO = ['app', 'versao', 'tipo', 'mensagem', 'origem', 'pilha', 'navegador', 'assinatura'];
  function backendRelatarErro(reg) {
    const limpo = {};
    for (const k of CAMPOS_ERRO) limpo[k] = String(reg[k] == null ? '' : reg[k]);
    return ponte().chamar('erro', { reg: limpo });
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
