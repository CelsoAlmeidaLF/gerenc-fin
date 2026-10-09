/* FINANC autosave: espelha o cofre (já cifrado, o mesmo do navegador) em arquivos de uma pasta do aparelho.
   O arquivo abre com o mesmo PIN FINANC: não há senha extra. Limpar os dados do navegador não apaga a pasta.
   Carregue depois de stk-pkg-secure-ui.js. */
(function (root) {
  'use strict';
  const FORMAT = 'financ-autosave-v1';
  const ID_KEY = 'financ-id-v1', VAULT_PREFIX = 'financ-vault-v1:', META_PREFIX = 'financ-autosave:';
  const FILE_RE = /^([a-z0-9-]{1,40})\.financ(\.bak)?\.json$/;
  const appOK = id => typeof id === 'string' && /^[a-z0-9-]{1,40}$/.test(id);
  const mainName = appId => appId + '.financ.json';
  const backupName = appId => appId + '.financ.bak.json';
  const DELAY_MS = 400;

  async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }
  const digestOf = (identity, vault) => sha256(FORMAT + '\n' + (identity || '') + '\n' + vault);
  const uidOf = identity => { try { const r = JSON.parse(identity); return r && typeof r.uid === 'string' ? r.uid : null; } catch (_) { return null; } };
  const linkedVault = vault => { try { return Boolean(JSON.parse(vault).identity); } catch (_) { return false; } };

  // Retrato do que está no navegador agora: o cofre do app e o FINANC ID, como texto cifrado.
  async function snapshot(storage, appId, appVersion = '', now = new Date()) {
    const vault = storage.getItem(VAULT_PREFIX + appId);
    if (!vault) return null;
    const identity = storage.getItem(ID_KEY);
    return { format: FORMAT, appId, appVersion, savedAt: now.toISOString(), identity, vault, digest: await digestOf(identity, vault) };
  }
  const serialize = snap => JSON.stringify(snap, null, 1);

  // Valida formato e integridade (SHA-256 do conteúdo). O cofre em si é autenticado pelo AES-GCM ao abrir.
  async function parse(text, expectedApp) {
    let m;
    try { m = JSON.parse(text); } catch (_) { throw new Error('Arquivo ilegível.'); }
    if (!m || m.format !== FORMAT || !appOK(m.appId) || typeof m.vault !== 'string' || typeof m.digest !== 'string'
      || typeof m.savedAt !== 'string' || Number.isNaN(Date.parse(m.savedAt)) || (m.identity !== null && typeof m.identity !== 'string')) throw new Error('Este arquivo não é um salvamento dos apps.');
    if (expectedApp && m.appId !== expectedApp) throw new Error('Este arquivo é de outro app (' + m.appId + ').');
    if (await digestOf(m.identity, m.vault) !== m.digest) throw new Error('Arquivo corrompido: a verificação de integridade falhou.');
    let envelope, identity = null;
    try { envelope = JSON.parse(m.vault); if (m.identity) identity = JSON.parse(m.identity); } catch (_) { throw new Error('Arquivo corrompido.'); }
    if (!envelope || envelope.version !== 1 || envelope.appId !== m.appId) throw new Error('Arquivo corrompido.');
    if (m.identity && (!identity || identity.version !== 1 || !identity.password || !identity.recovery)) throw new Error('Arquivo corrompido.');
    return m;
  }

  // O que restaurar sem apagar nada que já exista. Um cofre só entra onde ainda não há cofre daquele app,
  // e cofres ligados ao FINANC ID só entram se forem do mesmo FINANC ID (mesmo uid) do aparelho.
  function planRestore(storage, mirrors) {
    const newest = new Map();
    for (const m of mirrors) { const cur = newest.get(m.appId); if (!cur || Date.parse(m.savedAt) > Date.parse(cur.savedAt)) newest.set(m.appId, m); }
    const list = [...newest.values()].sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
    const localIdentity = storage.getItem(ID_KEY);
    let identity = null, uid = localIdentity ? uidOf(localIdentity) : null;
    if (!localIdentity) {
      const source = list.find(m => m.identity && linkedVault(m.vault)) || list.find(m => m.identity);
      if (source) { identity = source.identity; uid = uidOf(source.identity); }
    }
    const vaults = [], skipped = [];
    for (const m of list) {
      if (storage.getItem(VAULT_PREFIX + m.appId) !== null) { skipped.push({ appId: m.appId, reason: 'exists' }); continue; }
      if (linkedVault(m.vault) && (!uid || uidOf(m.identity) !== uid)) { skipped.push({ appId: m.appId, reason: 'other-identity' }); continue; }
      vaults.push(m);
    }
    return { identity, vaults, skipped };
  }
  function applyRestore(storage, plan) {
    const put = (key, value) => { storage.setItem(key, value); if (storage.getItem(key) !== value) throw new Error('Falha ao gravar no navegador.'); };
    if (plan.identity) put(ID_KEY, plan.identity);
    for (const m of plan.vaults) { put(VAULT_PREFIX + m.appId, m.vault); writeMeta(storage, m.appId, m); }
    return plan.vaults.map(m => m.appId);
  }
  function readMeta(storage, appId) { try { const m = JSON.parse(storage.getItem(META_PREFIX + appId)); return m && typeof m.digest === 'string' ? m : null; } catch (_) { return null; } }
  function writeMeta(storage, appId, snap) { try { storage.setItem(META_PREFIX + appId, JSON.stringify({ digest: snap.digest, savedAt: snap.savedAt })); } catch (_) {} }

  async function readText(dir, name) {
    try { return await (await (await dir.getFileHandle(name)).getFile()).text(); }
    catch (error) { if (error && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')) return null; throw error; }
  }
  // createWritable grava num arquivo temporário e só troca o original ao fechar: falha no meio não corrompe.
  async function writeText(dir, name, text) {
    const handle = await dir.getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    try { await writer.write(text); await writer.close(); }
    catch (error) { try { await writer.abort(); } catch (_) {} throw error; }
    const file = await handle.getFile();
    if (file.size !== new TextEncoder().encode(text).length) throw new Error('Falha ao confirmar a gravação do arquivo.');
  }
  async function readMirrors(dir) {
    const found = [];
    for await (const [name, handle] of dir.entries()) {
      const match = FILE_RE.exec(name);
      if (!match || handle.kind !== 'file') continue;
      try { found.push({ backup: Boolean(match[2]), mirror: await parse(await (await handle.getFile()).text(), match[1]) }); } catch (_) {}
    }
    // Usa o principal de cada app; o .bak só entra se o principal estiver faltando ou estragado.
    const mains = new Set(found.filter(f => !f.backup).map(f => f.mirror.appId));
    return found.filter(f => !f.backup || !mains.has(f.mirror.appId)).map(f => f.mirror);
  }

  function errorText(error) {
    const name = error && error.name;
    if (name === 'QuotaExceededError') return 'Sem espaço no aparelho para salvar o arquivo.';
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Sem permissão para gravar na pasta.';
    if (name === 'NotFoundError') return 'A pasta não foi encontrada. Escolha a pasta de novo.';
    if (name === 'NoModificationAllowedError' || name === 'InvalidStateError') return 'O arquivo está em uso. Tentando de novo…';
    return (error && error.message) || 'Falha ao salvar o arquivo.';
  }

  // Grava o arquivo do app na pasta: espera um pouco depois da última alteração, uma gravação por vez,
  // e não regrava quando nada mudou. Antes da primeira gravação da sessão, guarda a versão anterior em .bak.
  class AutoSave {
    constructor({ storage, appId, appVersion = '', delay = DELAY_MS, beforeWrite = async () => {}, onStatus = () => {}, now = () => new Date() }) {
      Object.assign(this, { storage, appId, appVersion, delay, beforeWrite, onStatus, now });
      this.dir = null; this.status = 'off'; this.error = ''; this.conflict = null;
      this.lastDigest = null; this.lastSaved = (readMeta(storage, appId) || {}).savedAt || null;
      this.rotated = false; this.timer = null; this.running = null; this.rerun = false; this.retries = 0;
    }
    get folder() { return this.dir ? this.dir.name || '' : ''; }
    set(status, error = '') { this.status = status; this.error = error; try { this.onStatus(this); } catch (_) {} }
    // Compara o arquivo da pasta com o navegador antes de gravar: um arquivo mais novo e diferente nunca é sobrescrito sem perguntar.
    async connect(dir) {
      this.dir = dir; this.rotated = false; this.lastDigest = null; this.conflict = null; this.retries = 0;
      try {
        const snap = await snapshot(this.storage, this.appId, this.appVersion, this.now());
        const text = await readText(dir, mainName(this.appId));
        let file = null;
        if (text !== null) { try { file = await parse(text, this.appId); } catch (_) {} }
        if (file && snap && file.digest === snap.digest) {
          this.lastDigest = file.digest; this.lastSaved = file.savedAt; writeMeta(this.storage, this.appId, file);
          this.set('saved'); return;
        }
        if (file && snap) {
          const meta = readMeta(this.storage, this.appId);
          const ours = meta && meta.digest === file.digest;
          const newer = !meta || Date.parse(file.savedAt) > Date.parse(meta.savedAt);
          if (!ours && newer) { this.conflict = file; this.set('conflict'); return; }
        }
      } catch (error) { this.set(error && error.name === 'NotAllowedError' ? 'reconnect' : 'error', errorText(error)); return; }
      this.set('pending'); await this.flush();
    }
    disconnect() { clearTimeout(this.timer); this.timer = null; this.dir = null; this.conflict = null; this.set('off'); }
    // Escolha do usuário quando o arquivo da pasta é diferente: manter o aparelho (o arquivo vai para o .bak).
    async keepLocal() { this.conflict = null; this.set('pending'); await this.flush(); }
    schedule() {
      // Sem permissão ou com conflito, espera o usuário: a próxima conexão grava tudo de uma vez.
      if (!this.dir || this.status === 'conflict' || this.status === 'reconnect') return;
      if (this.status !== 'saving') this.set('pending');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.delay);
    }
    async flush() {
      clearTimeout(this.timer); this.timer = null;
      if (this.running) { this.rerun = true; return this.running; }
      this.running = (async () => { do { this.rerun = false; await this.writeOnce(); } while (this.rerun); })();
      try { await this.running; } finally { this.running = null; }
    }
    async writeOnce() {
      if (!this.dir || this.conflict) return;
      try {
        await this.beforeWrite();
        const snap = await snapshot(this.storage, this.appId, this.appVersion, this.now());
        if (!snap) { this.set('saved'); return; }
        if (snap.digest === this.lastDigest) { this.set('saved'); return; }
        this.set('saving');
        if (!this.rotated) {
          const previous = await readText(this.dir, mainName(this.appId));
          if (previous !== null) {
            let old = null; try { old = await parse(previous, this.appId); } catch (_) {}
            if (old && old.digest !== snap.digest) await writeText(this.dir, backupName(this.appId), previous);
          }
          this.rotated = true;
        }
        await writeText(this.dir, mainName(this.appId), serialize(snap));
        this.lastDigest = snap.digest; this.lastSaved = snap.savedAt; this.retries = 0;
        writeMeta(this.storage, this.appId, snap);
        this.set('saved');
      } catch (error) {
        const name = error && error.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') { this.set('reconnect', errorText(error)); return; }
        this.set('error', errorText(error));
        // Arquivo ocupado ou falha passageira: tenta de novo algumas vezes, com espera crescente.
        if (this.retries < 3 && name !== 'QuotaExceededError' && name !== 'NotFoundError') {
          this.retries += 1; clearTimeout(this.timer);
          this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.delay * 4 * this.retries);
        }
      }
    }
  }

  const core = { FORMAT, AutoSave, snapshot, parse, serialize, planRestore, applyRestore, readMirrors, readMeta, writeMeta, mainName, backupName, digestOf };
  if (typeof module !== 'undefined' && module.exports) { module.exports = core; return; }
  root.FinancAutosave = core;
  if (typeof document === 'undefined' || !root.secureStorage || !root.FinancVault) return;

  /* ───────── Interface ───────── */
  const html = document.documentElement;
  const appId = html.dataset.vaultApp;
  const appName = html.dataset.vaultName || document.title;
  const vault = root.secureStorage;
  const storage = root.localStorage;
  const supported = typeof root.showDirectoryPicker === 'function';
  const icon = (name, size) => root.FinancIcons ? FinancIcons.svg(name, { size }) : '';
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = iso => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };

  // A pasta escolhida vale para todos os apps do mesmo endereço (mesmo IndexedDB); cada app grava o próprio arquivo.
  function handles(mode, run) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('financ-autosave', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result, tx = db.transaction('kv', mode), out = run(tx.objectStore('kv'));
        tx.oncomplete = () => { db.close(); resolve(out && 'result' in out ? out.result : undefined); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }
  const loadDir = () => handles('readonly', s => s.get('dir')).catch(() => null);
  const saveDir = dir => handles('readwrite', s => s.put(dir, 'dir')).catch(() => {});
  const forgetDir = () => handles('readwrite', s => s.delete('dir')).catch(() => {});
  async function permitted(dir, ask) {
    const opts = { mode: 'readwrite' };
    if (await dir.queryPermission(opts) === 'granted') return true;
    return ask ? await dir.requestPermission(opts) === 'granted' : false;
  }
  // Pede ao navegador para não apagar os dados sozinho por falta de espaço (não impede a limpeza manual).
  const persist = () => { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (_) {} };
  async function pickDir() {
    const dir = await root.showDirectoryPicker({ id: 'financ-dados', mode: 'readwrite', startIn: 'documents' });
    if (!await permitted(dir, true)) throw Object.assign(new Error('Sem permissão para gravar na pasta.'), { name: 'NotAllowedError' });
    await saveDir(dir); persist();
    return dir;
  }
  // Fallback universal: escolher arquivo(s) .financ.json (qualquer navegador, inclusive sem acesso a pastas).
  function pickFiles(multiple) {
    return new Promise(resolve => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.multiple = multiple;
      input.onchange = async () => {
        const out = [];
        for (const file of input.files) { try { out.push(await parse(await file.text())); } catch (error) { out.push({ error, name: file.name }); } }
        resolve(out);
      };
      input.oncancel = () => resolve([]);
      input.click();
    });
  }
  function download(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const skippedText = plan => plan.skipped.filter(s => s.reason === 'other-identity').length
    ? ' Alguns arquivos usam outro PIN de outro aparelho/instalação e não foram restaurados.' : '';

  /* Tela de PIN sem cofre deste app: oferece restaurar da pasta antes de criar um PIN novo. */
  function mountGateRestore() {
    const footer = document.querySelector('#vaultGate .vault-footer');
    if (!footer || vault.exists) return;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'vault-link'; button.id = 'vaultRestoreFolder';
    button.innerHTML = icon('upload', 16) + 'Restaurar dados salvos';
    footer.append(button);
    const say = text => { const m = document.getElementById('vaultMessage'); if (m) m.textContent = text; };
    button.onclick = async () => {
      say(''); button.disabled = true;
      try {
        let mirrors, dir = null;
        if (supported) { dir = await pickDir(); mirrors = await readMirrors(dir); }
        else mirrors = (await pickFiles(true)).filter(m => !m.error);
        if (!mirrors.length) { say(supported ? 'Nenhum dado salvo encontrado nesta pasta.' : 'Nenhum arquivo válido escolhido.'); return; }
        const plan = planRestore(storage, mirrors);
        const restored = applyRestore(storage, plan);
        if (!restored.includes(appId)) {
          say((restored.length ? 'Outros apps foram restaurados, mas não há dados deste app na pasta.' : 'Nada para restaurar: este aparelho já tem esses dados.') + skippedText(plan));
          return;
        }
        persist(); location.reload();
      } catch (error) { if (!error || error.name !== 'AbortError') say(errorText(error)); }
      finally { button.disabled = false; }
    };
  }

  /* Configurações → grupo "Salvar no celular", com os mesmos componentes da tela (fs-row, fs-switch, badge). */
  const BADGE = {
    off: null, reconnect: ['Pausado', 'warn'], pending: ['Pendente', 'info'], saving: ['Salvando', 'info'],
    saved: ['Salvo', 'pos'], error: ['Erro', 'neg'], conflict: ['Conferir', 'warn'], unsupported: null,
  };
  let saver = null, askedThisSession = false;
  const state = () => supported ? saver.status : 'unsupported';
  function statusText() {
    const s = state(), folder = saver.folder ? 'pasta ' + saver.folder : 'pasta escolhida';
    if (s === 'unsupported') return 'Este navegador não grava em pastas. Use "Baixar cópia" de vez em quando.';
    if (s === 'off') return 'Grava sozinho um arquivo no celular. Se o navegador for limpo, os dados voltam com o mesmo PIN.';
    if (s === 'reconnect') return 'O navegador pediu para confirmar o acesso à ' + folder + '.';
    if (s === 'error') return saver.error;
    if (s === 'conflict') return 'O arquivo da ' + folder + ' é mais novo que os dados deste aparelho. Escolha qual manter.';
    if (s === 'saved') return 'Salvo' + (saver.lastSaved ? ' em ' + when(saver.lastSaved) : '') + ' · ' + folder + '.';
    return 'Salvando na ' + folder + '…';
  }
  async function reconnect() {
    if (await permitted(saver.dir, true)) { persist(); await saver.connect(saver.dir); return ''; }
    return 'Sem permissão, o arquivo não é atualizado.';
  }
  // Erro de seletor cancelado não é erro: só não faz nada.
  const quiet = run => async () => { try { return await run(); } catch (error) { if (error && error.name === 'AbortError') return ''; throw Object.assign(new Error(errorText(error)), { name: 'AutosaveError' }); } };
  function rows() {
    if (!saver) return [];
    const s = state(), on = Boolean(saver.dir);
    const list = [{ id: 'main', icon: 'database', label: 'Salvar no celular', description: statusText(), badge: BADGE[s] && { text: BADGE[s][0], tone: BADGE[s][1] },
      toggle: on, disabled: !supported, onClick: quiet(async () => {
        if (on) { await forgetDir(); saver.disconnect(); return 'Parou de salvar na pasta. O arquivo que já existe continua lá.'; }
        await saver.connect(await pickDir()); return saver.status === 'saved' ? 'Pronto: salvando sozinho na pasta.' : '';
      }) }];
    if (s === 'reconnect') list.push({ id: 'reconnect', icon: 'refresh', label: 'Continuar salvando', description: 'Libera o acesso à pasta de novo.', accent: true, onClick: quiet(reconnect) });
    if (s === 'conflict') list.push(
      { id: 'use-file', icon: 'download', label: 'Usar o arquivo da pasta', description: 'Arquivo de ' + when(saver.conflict.savedAt) + '. Os dados atuais vão para o .bak.', accent: true, onClick: quiet(() => replaceWith(saver.conflict)) },
      { id: 'keep', icon: 'check', label: 'Manter os dados deste aparelho', description: 'O arquivo da pasta vai para o .bak.', onClick: quiet(async () => { await saver.keepLocal(); return 'Mantidos os dados deste aparelho.'; }) });
    if (on && s !== 'conflict' && s !== 'reconnect') list.push(
      { id: 'save', icon: 'check', label: 'Salvar agora', description: mainName(appId), onClick: quiet(async () => { await vault.flush(); await saver.flush(); return saver.status === 'saved' ? 'Salvo.' : ''; }) },
      { id: 'pick', icon: 'database', label: 'Trocar pasta', description: 'A mesma pasta vale para todos os apps.', onClick: quiet(async () => { await saver.connect(await pickDir()); return ''; }) });
    list.push(
      { id: 'restore', icon: 'upload', label: 'Restaurar de um arquivo', description: 'Escolha um arquivo .financ.json; abre com o mesmo PIN.', onClick: quiet(async () => {
        const [picked] = await pickFiles(false);
        if (!picked) return '';
        if (picked.error) throw picked.error;
        if (picked.appId !== appId) throw new Error('Este arquivo é de outro app (' + picked.appId + ').');
        return replaceWith(picked);
      }) },
      { id: 'download', icon: 'download', label: 'Baixar cópia', description: 'Mesmo arquivo, protegido pelo mesmo PIN. Sem senha extra.', onClick: quiet(async () => {
        await vault.flush();
        const snap = await snapshot(storage, appId, html.dataset.vaultVersion || '');
        if (!snap) throw new Error('Ainda não há dados para salvar.');
        download(serialize(snap), mainName(appId)); return 'Cópia baixada.';
      }) });
    return list;
  }
  // Erros que precisam de atenção usam o aviso de gravação que o kit já mostra no topo.
  const banner = () => document.getElementById('vaultSaveError');
  let bannerText = '';
  function onStatus() {
    const el = banner();
    if (el) {
      const next = saver.status === 'error' ? 'Não foi possível salvar no celular: ' + saver.error + ' Veja em Configurações.' : '';
      if (next) el.textContent = next; else if (el.textContent === bannerText) el.textContent = '';
      bannerText = next;
    }
    if (root.FinancSettings && root.FinancSettings.refresh) root.FinancSettings.refresh();
  }

  function confirmBox(title, text, action) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog'); dialog.className = 'vault-dialog';
      dialog.innerHTML = '<div class="vault-dialog-head"><span class="vault-badge vault-badge-danger">' + icon('alert', 18) + '</span><p><b></b></p></div><p class="vault-dim"></p><div class="vault-dialog-actions"><button type="button" data-a="no">Cancelar</button><button type="button" data-a="yes" class="vault-dialog-danger"></button></div>';
      dialog.querySelector('b').textContent = title; dialog.querySelector('.vault-dim').textContent = text;
      dialog.querySelector('[data-a=yes]').textContent = action;
      let result = false;
      dialog.querySelector('[data-a=no]').onclick = () => dialog.close();
      dialog.querySelector('[data-a=yes]').onclick = () => { result = true; dialog.close(); };
      dialog.onclose = () => { dialog.remove(); resolve(result); };
      document.body.append(dialog); dialog.showModal();
    });
  }
  // Troca os dados deste app pelos do arquivo. Antes, os dados atuais vão para o .bak da pasta (quando conectada).
  async function replaceWith(mirror) {
    const localUid = uidOf(storage.getItem(ID_KEY));
    if (linkedVault(mirror.vault) && localUid && uidOf(mirror.identity) !== localUid) throw new Error('Este arquivo usa o PIN de outra instalação e não abre aqui.');
    if (!await confirmBox('Substituir os dados?', 'Os dados deste app passam a ser os do arquivo de ' + when(mirror.savedAt) + '.'
      + (saver.dir ? ' Os dados atuais ficam guardados no arquivo .bak da pasta.' : ' Baixe uma cópia antes, se quiser guardar os atuais.'), 'Substituir')) return '';
    await vault.flush();
    if (saver.dir && await permitted(saver.dir, false)) {
      const current = await snapshot(storage, appId, html.dataset.vaultVersion || '');
      if (current && current.digest !== mirror.digest) await writeText(saver.dir, backupName(appId), serialize(current));
    }
    saver.conflict = null; saver.dir = null; // nada mais é gravado até recarregar
    vault.onStored = () => {};
    storage.setItem(VAULT_PREFIX + appId, mirror.vault);
    if (!storage.getItem(ID_KEY) && mirror.identity) storage.setItem(ID_KEY, mirror.identity);
    writeMeta(storage, appId, mirror);
    setTimeout(() => location.reload(), 300);
    return 'Dados restaurados. Reabrindo…';
  }

  function addSettings() {
    if (root.FinancSettings && root.FinancSettings.addGroup) root.FinancSettings.addGroup({ title: 'Salvar no celular', rows });
  }

  async function start() {
    saver = new AutoSave({
      storage, appId, appVersion: html.dataset.vaultVersion || '',
      beforeWrite: async () => { if (vault.pending) await vault.pending.catch(() => {}); },
      onStatus,
    });
    // FINANC ID de versões anteriores ganha o identificador fixo antes da primeira gravação.
    try { if (vault.identity.exists && typeof vault.identity.read().uid !== 'string') vault.identity.write(() => {}); } catch (_) {}
    const schedule = () => saver.schedule();
    vault.onStored = schedule; vault.identity.onWrite = schedule;
    // Ao sair do app (trocar de app, apagar a tela), grava já, sem esperar o intervalo. Não depende de beforeunload.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saver.dir) saver.flush(); });
    addEventListener('pagehide', () => { if (saver.dir) saver.flush(); });
    if (!supported) return;
    const dir = await loadDir();
    if (!dir) { saver.set('off'); return; }
    saver.dir = dir;
    try { if (await permitted(dir, false)) { persist(); await saver.connect(dir); } else saver.set('reconnect'); }
    catch (error) { saver.set('error', errorText(error)); }
    // Permissão expirada (comum no Android ao reabrir): pede de novo no primeiro toque no app, uma vez por sessão.
    if (saver.status === 'reconnect') addEventListener('pointerup', async function again(event) {
      if (askedThisSession || saver.status !== 'reconnect') { removeEventListener('pointerup', again, true); return; }
      if (event.target.closest && event.target.closest('dialog')) return;
      askedThisSession = true; removeEventListener('pointerup', again, true);
      try { await reconnect(); } catch (_) {}
    }, true);
  }

  mountGateRestore();
  addSettings();
  if (root.vaultReady) root.vaultReady.then(start).catch(() => {});
})(globalThis);
