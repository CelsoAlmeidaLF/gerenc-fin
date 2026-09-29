/* Loaded before application code. The app starts only after successful unlock. */
(function () {
  'use strict';
  const root = document.documentElement;
  const appId = root.dataset.vaultApp;
  const nativeStorage = window.localStorage;
  const LEGACY_KEYS = { 'cripito-sim': /^cripto[-:]/, 'cambio-sim': /^cambio_/, 'gerenc-fin': /^livro_caixa_/ };
  const matches = key => Boolean(LEGACY_KEYS[appId] && LEGACY_KEYS[appId].test(key));
  const icon = (name, size) => window.FinancIcons ? FinancIcons.svg(name, { size }) : '';
  const appName = root.dataset.vaultName || document.title.split(/\s[—–-]\s/)[0].trim();
  const VERSION = root.dataset.vaultVersion ? 'v' + root.dataset.vaultVersion : '';
  const logoLink = document.querySelector('link[rel="apple-touch-icon"], link[rel="icon"]');
  const PIN_STEPS = new Set(['unlock', 'create', 'create-confirm', 'recover-pin', 'recover-confirm']);
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'bio', '0', 'del'];
  const bio = FinancVault.webauthn;
  const DECLINED = 'financ-vault-bio-declined:' + appId, MANUAL_LOCK = 'financ-vault-manual-lock:' + appId, THEME_KEY = 'financ-theme:' + appId;
  const themeSupported = (root.dataset.vaultThemes || '').split(/\s+/).includes('light');
  function applyTheme(value) { if (value === 'light' || value === 'dark') root.dataset.theme = value; else delete root.dataset.theme; }
  if (themeSupported) { try { applyTheme(nativeStorage.getItem(THEME_KEY)); } catch (_) {} }
  const session = { take(key) { try { const v = sessionStorage.getItem(key); sessionStorage.removeItem(key); return v; } catch (_) { return null; } }, set(key) { try { sessionStorage.setItem(key, '1'); } catch (_) {} } };

  // O PIN é local ao cofre: gerenciadores de senha (Proton Pass, 1Password, Bitwarden, LastPass, Dashlane) não devem sugerir nem salvar.
  const NO_AUTOFILL = ' autocomplete="off" data-protonpass-ignore="true" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other"';
  function noAutofill(el) {
    el.setAttribute('autocomplete', 'off');
    for (const name of ['data-protonpass-ignore', 'data-1p-ignore', 'data-lpignore', 'data-bwignore']) el.setAttribute(name, 'true');
    el.setAttribute('data-form-type', 'other');
    return el;
  }
  const panel = document.createElement('section'); panel.id = 'vaultGate';
  panel.setAttribute('aria-labelledby', 'vaultTitle');
  panel.innerHTML = '<div class="vault-brand"><img class="vault-logo" alt="" width="40" height="40" hidden><div><div class="vault-app-name"></div><div class="vault-eyebrow">' + icon('shield-check', 12) + 'SEGURANÇA LOCAL</div></div></div>'
    + '<div class="vault-badge" id="vaultBadge">' + icon('lock', 22) + '</div>'
    + '<h1 id="vaultTitle">Dados protegidos</h1><p id="vaultHelp"></p>'
    + '<form id="vaultForm" novalidate' + NO_AUTOFILL + '>'
    + '<label id="vaultRecoveryLabel" class="vault-field" hidden>Código de recuperação<input id="vaultRecovery"' + NO_AUTOFILL + ' autocapitalize="none" spellcheck="false" placeholder="xxxxxxxx-xxxxxxxx-…"></label>'
    + '<div class="vault-pin-wrap" id="vaultPinWrap"><input id="vaultPin" name="vault-pin" class="vault-pin-input"' + NO_AUTOFILL + ' type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" aria-label="PIN de 6 números" aria-describedby="vaultHelp vaultMessage">'
    + '<div class="vault-dots" id="vaultDots" aria-hidden="true">' + '<span></span>'.repeat(6) + '</div></div>'
    + '<div class="vault-keypad" id="vaultKeypad">' + keys.map(k => k === 'bio'
      ? '<button type="button" tabindex="-1" data-key="bio" class="vault-key-bio is-off" aria-label="Desbloquear com biometria" title="Desbloquear com biometria">' + icon('fingerprint', 26) + '</button>'
      : k === 'del'
      ? '<button type="button" tabindex="-1" data-key="del" aria-label="Apagar">' + icon('delete', 22) + '</button>'
      : '<button type="button" tabindex="-1" data-key="' + k + '">' + k + '</button>').join('') + '</div>'
    + '<button id="vaultSubmit" class="vault-primary" type="submit">Desbloquear</button></form>'
    + '<div class="vault-footer"><button id="vaultBack" class="vault-link" type="button" hidden>' + icon('arrow-left', 16) + 'Voltar</button><button id="vaultRecover" class="vault-link" type="button">' + icon('key', 16) + 'Esqueci o PIN</button></div>'
    + '<p id="vaultMessage" role="alert"></p>'
    + (VERSION ? '<small class="vault-version"></small>' : '');
  panel.querySelector('.vault-app-name').textContent = appName;
  if (VERSION) panel.querySelector('.vault-version').textContent = VERSION;
  if (logoLink) { const logo = panel.querySelector('.vault-logo'); logo.src = logoLink.getAttribute('href'); logo.hidden = false; }
  document.body.append(panel);
  const get = id => document.getElementById(id);
  const status = document.createElement('div'); status.id = 'vaultSaveError'; status.setAttribute('role', 'alert'); document.body.append(status);
  let resolveReady, locking = false, lastActivity = Date.now(), failedAttempts = 0, blocked = false, busy = false;
  let step = 'unlock', firstPin = '', recoveryInput = '', countdown = null, bioAvailable = false;
  window.vaultReady = new Promise(resolve => { resolveReady = resolve; });
  const vault = new FinancVault.Vault(nativeStorage, appId, () => {
    status.textContent = 'Não foi possível salvar as últimas alterações. Mantenha esta página aberta e tente bloquear novamente para salvar.';
  });
  window.secureStorage = vault;
  // Uma aba por vez. Ao recarregar (bloqueio, atualização do app) a página anterior ainda pode segurar a trava
  // por alguns instantes, e no celular uma aba congelada em segundo plano segura sem aparecer: por isso tenta
  // de novo antes de desistir e oferece assumir o controle nesta aba.
  const LOCK_NAME = 'financ-vault:' + appId, TAKEOVER = 'financ-vault-takeover:' + appId;
  const TAB_BUSY = 'O aplicativo está aberto em outra aba ou janela.';
  let releaseTab, tabOwned = false;
  function holdTab(options) {
    return new Promise((resolve, reject) => {
      navigator.locks.request(LOCK_NAME, options, async lock => {
        if (!lock) { resolve(false); return; }
        tabOwned = true; resolve(true);
        await new Promise(done => { releaseTab = done; });
      }).catch(error => { if (tabOwned) lostTab(); else reject(error); });
    });
  }
  async function acquireTab() {
    if (!navigator.locks) throw new Error('Este navegador não suporta o bloqueio seguro de abas. Use um navegador atualizado.');
    if (session.take(TAKEOVER)) { await holdTab({ steal: true }); return; }
    for (let i = 0; i < 16; i++) {
      if (await holdTab({ ifAvailable: true })) return;
      await new Promise(done => setTimeout(done, 250));
    }
    throw new Error(TAB_BUSY);
  }
  function takeOver() { session.set(TAKEOVER); location.reload(); }
  // Outra aba assumiu: salva o que der (o cofre recusa gravar por cima de dados mais novos) e esquece a chave.
  function lostTab() {
    tabOwned = false; locking = true; root.classList.add('vault-locked'); dropSession();
    const save = vault.key ? vault.flush().catch(() => {}) : Promise.resolve();
    save.finally(() => vault.forget());
    const old = get('vaultGate'); if (old) old.remove();
    const gate = document.createElement('section'); gate.id = 'vaultGate';
    gate.innerHTML = '<div class="vault-badge">' + icon('lock', 22) + '</div><h1>Aberto em outra aba</h1><p>Este aplicativo passou a ser usado em outra aba ou janela. Para continuar aqui, assuma o controle.</p>';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'vault-primary'; button.textContent = 'Usar nesta aba';
    button.onclick = takeOver; gate.append(button); document.body.append(gate);
  }
  const tabReady = acquireTab();
  const block = error => {
    blocked = true; get('vaultMessage').textContent = error.message; setBusy(true);
    if (error.message !== TAB_BUSY || get('vaultTakeover')) return;
    const button = document.createElement('button'); button.id = 'vaultTakeover'; button.type = 'button'; button.className = 'vault-secondary';
    button.textContent = 'Usar nesta aba'; button.onclick = takeOver;
    get('vaultMessage').after(button);
  };
  // Prevent an early unhandled rejection while the user is typing.
  tabReady.catch(block);
  async function clearLegacySessionKeys() {
    if (appId !== 'gerenc-fin') return;
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('gerenc-fin-security-v1');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error('Não foi possível remover as chaves da sessão antiga.'));
      req.onblocked = () => reject(new Error('Feche as abas antigas do gerenciador para remover as chaves da sessão anterior.'));
    });
  }
  const legacyCleanup = tabReady.then(clearLegacySessionKeys);
  legacyCleanup.catch(block);

  // Recarregar a página não bloqueia: a chave do cofre fica cifrada no sessionStorage da aba (some ao fechar a aba)
  // por uma chave AES não-exportável guardada no IndexedDB. Só o bloqueio (manual, por inatividade ou ao sair) apaga.
  const SESSION = 'financ-vault-session:' + appId, RELOAD_GRACE_MS = 5000;
  function sessionStore(mode, run) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('financ-vault-session', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result, tx = db.transaction('keys', mode), result = run(tx.objectStore('keys'));
        tx.oncomplete = () => { db.close(); resolve(result.result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }
  async function loadSessionKey() {
    let key = await sessionStore('readonly', store => store.get(appId));
    if (!(key instanceof CryptoKey)) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await sessionStore('readwrite', store => store.put(key, appId));
    }
    vault.sessionKey = key;
  }
  const sessionReady = tabReady.then(loadSessionKey).catch(() => {});
  function readSession() { try { return JSON.parse(sessionStorage.getItem(SESSION)); } catch (_) { return null; } }
  function saveSession(extra) { if (vault.session) { try { sessionStorage.setItem(SESSION, JSON.stringify({ blob: vault.session, at: lastActivity, ...extra })); } catch (_) {} } }
  function dropSession() { try { sessionStorage.removeItem(SESSION); } catch (_) {} }
  const savedSession = readSession();
  // Enquanto reabre a sessão, mostra só o nome do app e a versão (sem piscar a tela de PIN).
  const boot = document.createElement('div'); boot.id = 'vaultBoot'; boot.setAttribute('aria-live', 'polite');
  boot.textContent = appName + (VERSION ? ' · ' + VERSION : '');
  if (savedSession) { panel.style.visibility = 'hidden'; document.body.append(boot); }
  async function resumeSession() {
    try {
      if (!savedSession || !savedSession.blob || typeof savedSession.at !== 'number' || !vault.exists) return false;
      await legacyCleanup; await sessionReady;
      await vault.resume(savedSession.blob);
      // Só vale se a última interação foi há menos que o tempo de bloqueio automático.
      const idle = Date.now() - savedSession.at;
      if (idle < 0 || idle >= autoLockMs()) { vault.forget(); return false; }
      // "Bloquear ao sair": recarregar esconde a página por instantes; ficar fora mais que isso exige o PIN.
      const away = typeof savedSession.hiddenAt === 'number' ? Date.now() - savedSession.hiddenAt : 0;
      if (vault.settings.lockOnHide && (away < 0 || away > RELOAD_GRACE_MS)) { vault.forget(); return false; }
      return true;
    } catch (_) { vault.forget(); return false; }
  }

  const pinInput = get('vaultPin');
  const COPY = {
    'unlock': ['Dados protegidos', 'Digite seu PIN de 6 números para abrir o aplicativo.', 'Desbloquear', 'lock'],
    'create': ['Crie seu PIN', 'Escolha 6 números. Os dados deste aplicativo serão criptografados neste navegador.', 'Continuar', 'shield'],
    'create-confirm': ['Confirme o PIN', 'Digite o mesmo PIN mais uma vez.', 'Criar PIN', 'shield'],
    'recover-code': ['Recuperar acesso', 'Informe o código de recuperação que você guardou ao criar o PIN.', 'Continuar', 'key'],
    'recover-pin': ['Novo PIN', 'Escolha um novo PIN de 6 números.', 'Continuar', 'key'],
    'recover-confirm': ['Confirme o novo PIN', 'Digite o novo PIN mais uma vez.', 'Definir novo PIN', 'key'],
  };
  function setBusy(value) {
    busy = value;
    const off = value || blocked;
    get('vaultSubmit').disabled = off || (PIN_STEPS.has(step) && pinInput.value.length !== 6);
    pinInput.disabled = off;
    panel.querySelectorAll('#vaultKeypad button').forEach(b => { b.disabled = off; });
  }
  function refreshBiometric() {
    const key = panel.querySelector('.vault-key-bio');
    if (!key) return;
    const show = step === 'unlock' && bioAvailable && Boolean(vault.biometric);
    key.classList.toggle('is-off', !show);
    key.tabIndex = show ? 0 : -1;
    if (step === 'unlock') get('vaultHelp').textContent = show ? 'Digite seu PIN ou toque na digital para usar a biometria.' : COPY.unlock[1];
  }
  function renderDots() {
    const n = pinInput.value.length;
    get('vaultDots').querySelectorAll('span').forEach((dot, i) => dot.classList.toggle('filled', i < n));
    if (!busy && !blocked) get('vaultSubmit').disabled = PIN_STEPS.has(step) && n !== 6;
  }
  function go(next) {
    step = next;
    const [title, help, action, badge] = COPY[step];
    get('vaultTitle').textContent = title; get('vaultHelp').textContent = help;
    get('vaultSubmit').textContent = action;
    get('vaultBadge').innerHTML = icon(badge, 22);
    const pinStep = PIN_STEPS.has(step);
    get('vaultPinWrap').hidden = !pinStep; get('vaultKeypad').hidden = !pinStep;
    get('vaultRecoveryLabel').hidden = step !== 'recover-code';
    get('vaultRecover').hidden = step !== 'unlock';
    get('vaultBack').hidden = step === 'unlock' || step === 'create';
    pinInput.value = ''; get('vaultDots').classList.remove('vault-shake'); renderDots(); refreshBiometric();
    if (!blocked) (pinStep ? pinInput : get('vaultRecovery')).focus({ preventScroll: true });
  }
  // Touch devices use the on-screen keypad; physical keyboards type into the input.
  if (matchMedia('(pointer: coarse)').matches) pinInput.inputMode = 'none';
  pinInput.oninput = () => {
    pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 6);
    if (pinInput.value) get('vaultDots').classList.remove('vault-shake');
    renderDots();
    if (pinInput.value.length === 6 && !busy) get('vaultForm').requestSubmit();
  };
  get('vaultKeypad').addEventListener('pointerdown', event => event.preventDefault());
  get('vaultKeypad').onclick = event => {
    const button = event.target.closest('button[data-key]');
    if (!button || button.disabled) return;
    const key = button.dataset.key;
    if (key === 'bio') { unlockWithBiometric(false); return; }
    pinInput.value = key === 'del' ? pinInput.value.slice(0, -1) : (pinInput.value + key).slice(0, 6);
    pinInput.oninput();
  };
  get('vaultPinWrap').onclick = () => pinInput.focus();
  get('vaultRecover').onclick = () => { get('vaultMessage').textContent = ''; go('recover-code'); };
  get('vaultBack').onclick = () => {
    get('vaultMessage').textContent = '';
    go({ 'create-confirm': 'create', 'recover-code': 'unlock', 'recover-pin': 'recover-code', 'recover-confirm': 'recover-pin' }[step]);
  };
  function fail(message) {
    get('vaultMessage').textContent = message;
    const dots = get('vaultDots'); dots.classList.remove('vault-shake'); void dots.offsetWidth; dots.classList.add('vault-shake');
    pinInput.value = ''; renderDots();
  }
  go(vault.exists ? 'unlock' : 'create');

  async function unlockWithBiometric(auto) {
    const info = vault.biometric;
    if (!info || busy || blocked || step !== 'unlock') return;
    setBusy(true); get('vaultMessage').textContent = '';
    try {
      await legacyCleanup; await sessionReady;
      const secret = await bio.evaluate(info.credentialId, info.prfSalt);
      try { await vault.unlockBiometric(secret); } finally { secret.fill(0); }
      failedAttempts = 0; get('vaultForm').reset(); finish();
    } catch (error) {
      if (!auto) get('vaultMessage').textContent = error.name === 'NotAllowedError' ? 'Biometria cancelada ou não reconhecida. Use o PIN.'
        : error.name === 'OperationError' ? 'Esta biometria não abre este cofre. Use o PIN e ative a biometria de novo.'
        : error.name === 'SecurityError' ? 'A biometria só funciona com o app aberto em um domínio HTTPS ou em localhost. Use o PIN.' : error.message;
      setBusy(false); pinInput.focus({ preventScroll: true });
    }
  }
  const resumed = resumeSession().then(ok => {
    boot.remove();
    if (ok) finish(); else { dropSession(); panel.style.visibility = ''; }
    return ok;
  });
  Promise.all([bio.available(), resumed]).then(([available, ok]) => {
    bioAvailable = available;
    if (ok) return;
    refreshBiometric();
    // Ao abrir o app, pede a biometria direto; após um bloqueio manual, espera o toque na digital.
    const manual = session.take(MANUAL_LOCK);
    if (available && vault.biometric && step === 'unlock' && !manual && document.visibilityState === 'visible') unlockWithBiometric(true);
  });
  function declined() { try { return nativeStorage.getItem(DECLINED) === '1'; } catch (_) { return true; } }
  async function enrollBiometric(pin) {
    await vault.verifyPin(pin);
    const enrolled = await bio.enroll(appName, appId);
    try { await vault.enableBiometric(pin, enrolled.credentialId, enrolled.prfSalt, enrolled.secret); }
    finally { enrolled.secret.fill(0); }
    try { nativeStorage.removeItem(DECLINED); } catch (_) {}
  }
  function biometricError(error) {
    return error.name === 'NotAllowedError' ? 'Cadastro cancelado.' : error.name === 'InvalidStateError' ? 'Este aparelho já tem uma credencial para este app. Tente de novo.'
      : error.name === 'OperationError' ? 'PIN incorreto.' : error.name === 'SecurityError' ? 'A biometria só funciona com o app aberto em um domínio HTTPS ou em localhost.' : error.message;
  }
  function offerBiometric(pin) {
    if (!bioAvailable || vault.biometric || declined()) { finish(); return; }
    panel.replaceChildren();
    const badge = document.createElement('div'); badge.className = 'vault-badge'; badge.innerHTML = icon('fingerprint', 24);
    const title = document.createElement('h1'); title.id = 'vaultTitle'; title.textContent = 'Desbloquear com biometria?';
    const help = document.createElement('p'); help.textContent = 'Use a digital, o rosto ou o bloqueio de tela deste aparelho para abrir o app. O PIN continua funcionando.';
    const enable = document.createElement('button'); enable.type = 'button'; enable.className = 'vault-primary';
    enable.innerHTML = icon('fingerprint', 18) + '<span>Ativar biometria</span>';
    const skip = document.createElement('button'); skip.type = 'button'; skip.className = 'vault-secondary'; skip.textContent = 'Agora não';
    const message = document.createElement('p'); message.id = 'vaultMessage'; message.setAttribute('role', 'alert');
    enable.onclick = async () => {
      enable.disabled = skip.disabled = true; message.textContent = '';
      try { await enrollBiometric(pin); pin = ''; finish(); }
      catch (error) { message.textContent = biometricError(error); enable.disabled = skip.disabled = false; }
    };
    skip.onclick = () => { try { nativeStorage.setItem(DECLINED, '1'); } catch (_) {} pin = ''; finish(); };
    panel.append(badge, title, help, enable, skip, message);
    enable.focus();
  }

  function finish() {
    vault.cleanupLegacy(matches);
    root.classList.remove('vault-locked'); panel.remove();
    const tools = document.createElement('div'); tools.id = 'vaultTools'; tools.setAttribute('role', 'group'); tools.setAttribute('aria-label', 'Segurança');
    const settings = document.createElement('button'); settings.id = 'vaultSettingsBtn'; settings.type = 'button';
    settings.title = 'Configurações'; settings.setAttribute('aria-label', 'Configurações');
    settings.innerHTML = icon('settings', 17); settings.onclick = () => FinancSettings.open();
    const lockButton = document.createElement('button'); lockButton.id = 'vaultLock'; lockButton.type = 'button';
    lockButton.title = 'Bloquear aplicativo'; lockButton.setAttribute('aria-label', 'Bloquear aplicativo');
    lockButton.innerHTML = icon('lock', 16) + '<span>Bloquear</span>';
    lockButton.onclick = () => window.lockVault();
    if (VERSION) { const ver = document.createElement('span'); ver.className = 'vault-tools-version'; ver.textContent = VERSION; ver.title = appName + ' ' + VERSION; tools.append(ver); }
    tools.append(settings, lockButton); document.body.append(tools);
    resolveReady(); lastActivity = Date.now(); saveSession();
  }
  function showRecoveryCode(recovery, pin, renewed = false) {
    // Show once and require acknowledgement before entering the application.
    panel.replaceChildren();
    panel.classList.add('vault-recovery');
    const badge = document.createElement('div'); badge.className = 'vault-badge'; badge.innerHTML = icon('key', 22);
    const title = document.createElement('h1'); title.id = 'vaultTitle'; title.textContent = renewed ? 'Seu novo código de recuperação' : 'Guarde seu código de recuperação';
    const help = document.createElement('p'); help.textContent = (renewed ? 'O código usado deixou de valer. ' : '') + 'Este código permite redefinir o PIN. Guarde-o offline, separado dos backups. Ele não será exibido novamente.';
    const code = document.createElement('p'); code.id = 'vaultRecoveryCode'; code.textContent = recovery;
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'vault-secondary';
    copy.innerHTML = icon('copy', 16) + '<span>Copiar código</span>';
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(recovery); copy.innerHTML = icon('check', 16) + '<span>Copiado</span>'; }
      catch (_) { getSelection().selectAllChildren(code); }
    };
    const done = document.createElement('button'); done.id = 'vaultRecoveryDone'; done.type = 'button'; done.className = 'vault-primary';
    done.textContent = 'Guardei o código'; done.onclick = () => offerBiometric(pin);
    panel.append(badge, title, help, code, copy, done);
    done.focus();
  }
  get('vaultForm').onsubmit = async event => {
    event.preventDefault();
    if (busy || blocked) return;
    get('vaultMessage').textContent = '';
    const pin = pinInput.value;
    if (step === 'recover-code') {
      recoveryInput = get('vaultRecovery').value.trim().toLowerCase();
      if (!/^[0-9a-f]{8}(-[0-9a-f]{8}){7}$/.test(recoveryInput)) { get('vaultMessage').textContent = 'Código de recuperação inválido.'; return; }
      go('recover-pin'); return;
    }
    if (!FinancVault.pinOK(pin)) { fail('Digite exatamente 6 números.'); return; }
    if (step === 'create' || step === 'recover-pin') { firstPin = pin; go(step === 'create' ? 'create-confirm' : 'recover-confirm'); return; }
    if ((step === 'create-confirm' || step === 'recover-confirm') && pin !== firstPin) {
      firstPin = ''; go(step === 'create-confirm' ? 'create' : 'recover-pin'); fail('Os PINs não coincidem. Comece de novo.'); return;
    }
    setBusy(true);
    try {
      await legacyCleanup; await sessionReady;
      if (!crypto.subtle) throw new Error('Abra o aplicativo em HTTPS ou localhost para proteger os dados.');
      if (!vault.exists) {
        const initial = Object.create(null);
        for (let i = 0; i < nativeStorage.length; i++) { const key = nativeStorage.key(i); if (matches(key)) initial[key] = nativeStorage.getItem(key); }
        showRecoveryCode(await vault.create(pin, initial), pin);
      } else {
        const renewed = step === 'recover-confirm' ? await vault.resetPassword(recoveryInput, pin) : null;
        if (!renewed) await vault.unlock(pin);
        failedAttempts = 0; firstPin = ''; recoveryInput = '';
        get('vaultForm').reset();
        if (renewed) showRecoveryCode(renewed, pin, true); else offerBiometric(pin);
      }
    } catch (error) {
      failedAttempts += 1;
      const wrong = error.name === 'OperationError';
      const delay = wrong ? Math.min(30000, failedAttempts * failedAttempts * 500) : 0;
      if (wrong && step === 'recover-confirm') go('recover-code');
      fail(wrong ? (step === 'recover-code' ? 'Código de recuperação incorreto.' : 'PIN incorreto.') : error.message);
      if (delay) {
        const message = get('vaultMessage').textContent; const until = Date.now() + delay;
        clearInterval(countdown);
        const tick = () => {
          const left = Math.ceil((until - Date.now()) / 1000);
          if (left <= 0) { clearInterval(countdown); get('vaultMessage').textContent = message; setBusy(false); pinInput.focus(); return; }
          get('vaultMessage').textContent = message + ' Aguarde ' + left + 's.';
        };
        tick(); countdown = setInterval(tick, 250);
      } else setBusy(false);
    }
  };
  window.lockVault = async () => {
    if (locking) return;
    locking = true; root.classList.add('vault-locked'); session.set(MANUAL_LOCK); dropSession();
    const message = document.createElement('section'); message.id = 'vaultGate'; message.className = 'vault-busy';
    message.innerHTML = '<div class="vault-badge">' + icon('lock', 22) + '</div><p>Salvando e bloqueando…</p>' + (VERSION ? '<small class="vault-version">' + VERSION + '</small>' : '');
    document.body.append(message);
    try { await vault.lock(); location.reload(); }
    catch (_) {
      message.replaceChildren();
      const badge = document.createElement('div'); badge.className = 'vault-badge vault-badge-danger'; badge.innerHTML = icon('alert', 22);
      const text = document.createElement('p'); text.textContent = 'Falha ao salvar. Os dados continuam nesta sessão. Tente novamente antes de fechar.';
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'vault-primary'; retry.textContent = 'Tentar salvar e bloquear';
      retry.onclick = () => { message.remove(); locking = false; window.lockVault(); };
      message.append(badge, text, retry);
    }
  };
  const activity = () => {
    if (!vault.key || locking) return;
    if (Date.now() - lastActivity >= autoLockMs()) { window.lockVault(); return; }
    lastActivity = Date.now(); saveSession();
  };
  ['pointerdown', 'keydown', 'touchstart'].forEach(name => window.addEventListener(name, activity, { passive: true }));
  const autoLockMs = () => vault.settings.autoLockMinutes * 60 * 1000;
  setInterval(() => { if (vault.key && !locking && Date.now() - lastActivity >= autoLockMs()) window.lockVault(); }, 5000);
  // Ao esconder só marca o momento (recarregar também esconde a página); ao voltar para a aba, bloqueia.
  document.addEventListener('visibilitychange', () => {
    if (!vault.key || locking || !vault.settings.lockOnHide) return;
    if (document.visibilityState === 'hidden') saveSession({ hiddenAt: Date.now() });
    else window.lockVault();
  });
  window.addEventListener('focus', activity);
  window.addEventListener('beforeunload', event => { if (vault.dirty || vault.pending) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { vault.forget(); if (releaseTab) releaseTab(); });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  window.addEventListener('storage', event => { if (event.key === vault.storageKey && vault.key) window.lockVault(); });
  // PINs are collected in a masked, numeric field. Legacy secrets remain readable during migration.
  window.askSecret = (label, create = false, legacy = false) => new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'vault-dialog';
    const form = noAutofill(document.createElement('form')); form.method = 'dialog';
    const head = document.createElement('div'); head.className = 'vault-dialog-head'; head.innerHTML = '<span class="vault-badge">' + icon(create ? 'shield' : 'lock', 18) + '</span>';
    const title = document.createElement('p'); title.textContent = label; head.append(title);
    const input = noAutofill(document.createElement('input')); input.type = 'password'; input.required = true; input.setAttribute('aria-label', label);
    const confirm = noAutofill(document.createElement('input')); confirm.type = 'password'; confirm.placeholder = 'Repita o PIN'; confirm.required = create; confirm.hidden = !create; confirm.setAttribute('aria-label', 'Repita o PIN');
    if (!legacy) for (const field of [input, confirm]) { field.className = 'vault-pin'; field.inputMode = 'numeric'; field.pattern = '[0-9]{6}'; field.minLength = 6; field.maxLength = 6; field.placeholder = '••••••'; }
    const actions = document.createElement('div'); actions.className = 'vault-dialog-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancelar'; cancel.onclick = () => dialog.close();
    const submit = document.createElement('button'); submit.textContent = 'Confirmar';
    actions.append(cancel, submit);
    let result = null;
    form.onsubmit = event => { if (!legacy && !FinancVault.pinOK(input.value)) { event.preventDefault(); input.setCustomValidity('Digite exatamente 6 números.'); input.reportValidity(); return; } if (create && input.value !== confirm.value) { event.preventDefault(); confirm.setCustomValidity('Os PINs não coincidem.'); confirm.reportValidity(); return; } result = input.value; };
    input.oninput = () => input.setCustomValidity('');
    confirm.oninput = () => confirm.setCustomValidity('');
    dialog.onclose = () => { input.value = ''; confirm.value = ''; dialog.remove(); resolve(result); };
    form.append(head, input, confirm, actions); dialog.append(form); document.body.append(dialog); dialog.showModal(); input.focus();
  });
  /* ───────── Configurações (aba ou tela cheia) ───────── */
  const extraSections = [];
  let pinFailures = 0, pinBlockedUntil = 0;
  // Operações que conferem o PIN dentro do app também têm espera progressiva contra tentativa e erro.
  async function withPin(label, action) {
    const wait = pinBlockedUntil - Date.now();
    if (wait > 0) throw new Error('Muitas tentativas. Aguarde ' + Math.ceil(wait / 1000) + 's.');
    const pin = await window.askSecret(label);
    if (!pin) return null;
    try { const result = await action(pin); pinFailures = 0; return result ?? true; }
    catch (error) {
      if (error.name === 'OperationError') {
        pinFailures += 1; pinBlockedUntil = Date.now() + Math.min(30000, pinFailures * pinFailures * 500);
        throw new Error('PIN incorreto.');
      }
      throw error;
    }
  }
  function dialogBox(build) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog'); dialog.className = 'vault-dialog';
      let result = false;
      const close = value => { result = value; dialog.close(); };
      build(dialog, close);
      dialog.onclose = () => { dialog.remove(); resolve(result); };
      document.body.append(dialog); dialog.showModal();
    });
  }
  function confirmDanger(title, text, action) {
    return dialogBox((dialog, close) => {
      dialog.innerHTML = '<div class="vault-dialog-head"><span class="vault-badge vault-badge-danger">' + icon('alert', 18) + '</span><p><b></b></p></div><p class="vault-dim"></p><div class="vault-dialog-actions"><button type="button" data-a="no">Cancelar</button><button type="button" data-a="yes" class="vault-dialog-danger"></button></div>';
      dialog.querySelector('b').textContent = title; dialog.querySelector('.vault-dim').textContent = text;
      dialog.querySelector('[data-a=yes]').textContent = action;
      dialog.querySelector('[data-a=no]').onclick = () => close(false);
      dialog.querySelector('[data-a=yes]').onclick = () => close(true);
    });
  }
  function showCodeDialog(code) {
    return dialogBox((dialog, close) => {
      dialog.innerHTML = '<div class="vault-dialog-head"><span class="vault-badge">' + icon('key', 18) + '</span><p><b>Novo código de recuperação</b></p></div><p class="vault-dim">O código anterior deixou de funcionar. Guarde este offline; ele não será exibido novamente.</p><p class="vault-code"></p><div class="vault-dialog-actions"><button type="button" data-a="copy">' + icon('copy', 16) + 'Copiar</button><button type="button" data-a="ok" class="vault-dialog-primary">Guardei</button></div>';
      const box = dialog.querySelector('.vault-code'); box.textContent = code;
      const copy = dialog.querySelector('[data-a=copy]');
      copy.onclick = async () => { try { await navigator.clipboard.writeText(code); copy.innerHTML = icon('check', 16) + 'Copiado'; } catch (_) { getSelection().selectAllChildren(box); } };
      dialog.querySelector('[data-a=ok]').onclick = () => close(true);
      dialog.oncancel = event => event.preventDefault();
    });
  }
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const row = (ic, label, desc, control = '', attrs = '') => '<div class="fs-row"' + attrs + '><span class="fs-ic">' + icon(ic, 18) + '</span><div class="fs-text"><b>' + esc(label) + '</b>' + (desc ? '<span>' + esc(desc) + '</span>' : '') + '</div>' + control + '</div>';
  const actionRow = (id, ic, label, desc, cls = '') => '<button type="button" class="fs-row fs-action ' + cls + '" data-fs="' + id + '"><span class="fs-ic">' + icon(ic, 18) + '</span><span class="fs-text"><b>' + esc(label) + '</b>' + (desc ? '<span>' + esc(desc) + '</span>' : '') + '</span>' + icon('chevron-right', 16) + '</button>';
  const toggle = (id, on, disabled) => '<button type="button" role="switch" class="fs-switch" data-fs="' + id + '" aria-checked="' + on + '"' + (disabled ? ' disabled' : '') + '><span></span></button>';
  const group = (title, body) => '<section class="fs-group"><h3 class="fs-title">' + esc(title) + '</h3><div class="fs-list">' + body + '</div></section>';

  function renderSettings(container) {
    if (!vault.key) return;
    const cfg = vault.settings, bioOn = Boolean(vault.biometric);
    let theme = 'system'; try { theme = nativeStorage.getItem(THEME_KEY) || 'system'; } catch (_) {}
    const size = (() => { try { return (nativeStorage.getItem(vault.storageKey) || '').length; } catch (_) { return 0; } })();
    let html = group('Segurança',
      actionRow('pin', 'key', 'Alterar PIN', 'Pede o PIN atual e o novo PIN.')
      + row('fingerprint', 'Biometria', bioOn ? 'Ativada: digital, rosto ou bloqueio de tela.' : bioAvailable ? 'Desativada.' : 'Indisponível neste aparelho ou navegador.', toggle('bio', bioOn, !bioOn && !bioAvailable))
      + row('clock', 'Bloqueio automático', 'Sem uso por este tempo, o app bloqueia.', '<select class="fs-select" data-fs="autolock" aria-label="Bloqueio automático">' + FinancVault.AUTO_LOCK_MINUTES.map(m => '<option value="' + m + '"' + (m === cfg.autoLockMinutes ? ' selected' : '') + '>' + m + ' min</option>').join('') + '</select>')
      + row('eye-off', 'Bloquear ao sair do app', 'Bloqueia ao trocar de aba, minimizar ou apagar a tela.', toggle('hide', cfg.lockOnHide))
      + actionRow('recovery', 'shield-check', 'Novo código de recuperação', 'Gera outro código e invalida o anterior.')
      + actionRow('lock', 'lock', 'Bloquear agora', '', 'fs-accent'));
    if (themeSupported) html += group('Aparência', row('sun', 'Tema', '', '<div class="fs-seg" role="group" aria-label="Tema">'
      + [['system', 'monitor', 'Sistema'], ['dark', 'moon', 'Escuro'], ['light', 'sun', 'Claro']].map(([v, ic, l]) => '<button type="button" data-fs="theme" data-v="' + v + '" aria-pressed="' + (theme === v) + '" title="' + l + '">' + icon(ic, 15) + '<span>' + l + '</span></button>').join('') + '</div>', ' data-wide'));
    extraSections.forEach((sec, si) => { html += group(sec.title, sec.rows.map((r, ri) => actionRow('x' + si + '-' + ri, r.icon || 'chevron-right', r.label, r.description || '', r.danger ? 'fs-danger' : '')).join('')); });
    html += group('Sobre', row('database', 'Armazenamento', 'Cofre local criptografado (AES-256-GCM) · ' + Math.max(1, Math.round(size / 1024)) + ' KB neste navegador.')
      + row('info', appName + (VERSION ? ' ' + VERSION : ''), 'Kit de segurança FINANC 1.3 · PIN, biometria e bloqueio automático.'));
    html += group('Zona de perigo', actionRow('destroy', 'trash', 'Apagar todos os dados deste app', 'Remove o cofre deste navegador. Não pode ser desfeito.', 'fs-danger'));
    container.innerHTML = '<div class="fs">' + html + '<p class="fs-toast" role="status" aria-live="polite"></p></div>';
    container.onclick = event => handle(event, container);
    container.onchange = event => handle(event, container);
  }
  async function handle(event, container) {
    const el = event.target.closest('[data-fs]');
    if (!el || el.disabled || !container.contains(el)) return;
    const kind = el.dataset.fs;
    if (kind === 'autolock' && event.type !== 'change') return;
    if (kind !== 'autolock' && event.type === 'change') return;
    const toast = container.querySelector('.fs-toast');
    const say = (text, bad) => { toast.textContent = text; toast.classList.toggle('fs-bad', Boolean(bad)); };
    say('');
    el.disabled = true;
    try {
      if (kind === 'pin') {
        const changed = await withPin('Digite o PIN atual:', async current => {
          await vault.verifyPin(current);
          const next = await window.askSecret('Crie o novo PIN de 6 números:', true);
          if (!next) return false;
          if (next === current) throw new Error('O novo PIN precisa ser diferente do atual.');
          await vault.changePin(current, next); return true;
        });
        if (changed) say('PIN alterado.');
      } else if (kind === 'bio') {
        if (vault.biometric) {
          const { credentialId } = vault.biometric;
          await vault.disableBiometric(); bio.forget(credentialId);
          try { nativeStorage.setItem(DECLINED, '1'); } catch (_) {}
          say('Biometria desativada. Use o PIN para abrir.');
        } else if (await withPin('Digite seu PIN para ativar a biometria:', pin => enrollBiometric(pin))) say('Biometria ativada.');
      } else if (kind === 'autolock') {
        const minutes = Number(el.value);
        await vault.setSettings({ autoLockMinutes: minutes }); lastActivity = Date.now();
        say('Bloqueio automático: ' + minutes + ' min.');
      } else if (kind === 'hide') {
        const next = await vault.setSettings({ lockOnHide: !vault.settings.lockOnHide });
        say(next.lockOnHide ? 'O app vai bloquear ao sair.' : 'Bloqueio ao sair desativado.');
      } else if (kind === 'recovery') {
        const code = await withPin('Digite seu PIN para gerar um novo código:', pin => vault.rotateRecovery(pin));
        if (typeof code === 'string') { await showCodeDialog(code); say('Novo código de recuperação ativo.'); }
      } else if (kind === 'lock') {
        window.lockVault(); return;
      } else if (kind === 'theme') {
        const value = el.dataset.v;
        try { if (value === 'system') nativeStorage.removeItem(THEME_KEY); else nativeStorage.setItem(THEME_KEY, value); } catch (_) {}
        applyTheme(value);
      } else if (kind === 'destroy') {
        if (!await confirmDanger('Apagar todos os dados?', 'O cofre deste app será removido deste navegador, incluindo PIN, biometria e todos os registros. Faça um backup antes, se precisar.', 'Apagar tudo')) { el.disabled = false; return; }
        const credential = vault.biometric;
        const done = await withPin('Digite seu PIN para apagar tudo:', pin => vault.destroy(pin));
        if (done) {
          if (credential) bio.forget(credential.credentialId);
          try { nativeStorage.removeItem(DECLINED); } catch (_) {}
          locking = true; location.reload(); return;
        }
      } else if (kind[0] === 'x') {
        const [si, ri] = kind.slice(1).split('-').map(Number);
        const target = extraSections[si] && extraSections[si].rows[ri];
        if (target) { el.disabled = false; closeSheet(); await target.onClick(); return; }
      }
    } catch (error) { say(biometricError(error), true); }
    const message = toast.textContent, bad = toast.classList.contains('fs-bad');
    renderSettings(container);
    const fresh = container.querySelector('.fs-toast'); fresh.textContent = message; fresh.classList.toggle('fs-bad', bad);
  }
  let sheet = null;
  function closeSheet() { if (sheet) sheet.close(); }
  window.FinancSettings = {
    // Seção própria do app: { title, rows: [{ icon, label, description, danger, onClick }] }
    addSection(section) {
      if (!section || typeof section.title !== 'string' || !Array.isArray(section.rows)) throw new Error('Seção inválida.');
      extraSections.push({ title: section.title, rows: section.rows.filter(r => r && typeof r.label === 'string' && typeof r.onClick === 'function') });
    },
    mount(container) { renderSettings(container); },
    open() {
      if (!vault.key || sheet) return;
      sheet = document.createElement('dialog'); sheet.className = 'fs-sheet'; sheet.setAttribute('aria-labelledby', 'fsSheetTitle');
      sheet.innerHTML = '<header class="fs-head"><button type="button" class="fs-back" aria-label="Voltar">' + icon('arrow-left', 20) + '</button><div><h2 id="fsSheetTitle">Configurações</h2><span></span></div></header><div class="fs-body"></div>';
      sheet.querySelector('.fs-head span').textContent = appName;
      sheet.querySelector('.fs-back').onclick = closeSheet;
      sheet.onclose = () => { sheet.remove(); sheet = null; };
      document.body.append(sheet); renderSettings(sheet.querySelector('.fs-body')); sheet.showModal();
    },
  };
  window.vaultSettings = () => window.FinancSettings.open();
  window.exportProtected = async (value, context, filename) => {
    const pin = await window.askSecret('Crie um PIN de 6 números para este arquivo:', true);
    if (!pin) return;
    const payload = await FinancVault.protect(value, pin, context);
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
  };
  window.importCertificate = async (payload, context) => {
    if (payload && payload.format === 'financ-encrypted-v1') {
      const pin = await window.askSecret('PIN do certificado:');
      if (!pin) throw new Error('Importação cancelada.');
      payload = await FinancVault.unprotect(payload, pin, context);
    } else if (!confirm('Este certificado antigo está sem criptografia. Importar e protegê-lo no cofre? Depois exporte uma cópia protegida.')) throw new Error('Importação cancelada.');
    if (!payload || typeof payload.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(payload.id) || typeof payload.secret !== 'string' || atob(payload.secret).length !== 32) throw new Error('Certificado inválido.');
    return payload;
  };
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => reg.update()).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!vault.key) location.reload(); });
  }
})();
