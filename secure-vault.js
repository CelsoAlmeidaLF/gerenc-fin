/* FINANC vault v1. Web Crypto only; never persist an unwrapped key. */
(function (root) {
  'use strict';
  const ITERATIONS = 600000;
  const enc = new TextEncoder();
  const b64 = bytes => { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const random = size => crypto.getRandomValues(new Uint8Array(size));
  const pinOK = pin => typeof pin === 'string' && /^\d{6}$/.test(pin);
  async function derive(secret, salt) {
    const material = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, material,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  // Biometria: o segredo PRF do WebAuthn (32 bytes, só liberado após verificação do usuário) vira chave AES via HKDF.
  async function hkdfKey(secret, salt, context) {
    const bytes = new Uint8Array(secret);
    if (bytes.length < 32) throw new Error('Segredo biométrico inválido.');
    const material = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(context) }, material,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function seal(value, key, context) {
    const iv = random(12);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, key, enc.encode(JSON.stringify(value)));
    return { iv: b64(iv), ciphertext: b64(ciphertext) };
  }
  async function open(payload, key, context) {
    if (!payload || typeof payload.iv !== 'string' || typeof payload.ciphertext !== 'string') throw new Error('Formato inválido.');
    const iv = unb64(payload.iv);
    if (iv.length !== 12) throw new Error('Formato inválido.');
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, key, unb64(payload.ciphertext));
    return JSON.parse(new TextDecoder().decode(data));
  }
  async function protectWithSecret(value, secret, context) {
    const salt = random(16);
    return { format: 'financ-encrypted-v1', context, iterations: ITERATIONS, salt: b64(salt), ...await seal(value, await derive(secret, salt), context) };
  }
  async function protect(value, pin, context) {
    if (!pinOK(pin)) throw new Error('Use um PIN de 6 números.');
    return protectWithSecret(value, pin, context);
  }
  async function unprotect(payload, pin, context) {
    if (!payload || payload.format !== 'financ-encrypted-v1' || payload.context !== context || payload.iterations !== ITERATIONS) throw new Error('Formato incompatível.');
    const salt = unb64(payload.salt);
    if (salt.length !== 16) throw new Error('Formato inválido.');
    return open(payload, await derive(pin, salt), context);
  }
  // Preferências cifradas e autenticadas com a chave de dados (só existem com o cofre aberto); só valores da lista são aceitos.
  const AUTO_LOCK_MINUTES = [1, 5, 15, 30];
  const DEFAULT_SETTINGS = Object.freeze({ autoLockMinutes: 15, lockOnHide: false });
  function cleanSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      autoLockMinutes: AUTO_LOCK_MINUTES.includes(s.autoLockMinutes) ? s.autoLockMinutes : DEFAULT_SETTINGS.autoLockMinutes,
      lockOnHide: s.lockOnHide === true,
    };
  }
  function recoveryCode() { return Array.from(random(32), n => n.toString(16).padStart(2, '0')).join('').match(/.{8}/g).join('-'); }
  class Vault {
    constructor(storage, appId, onError = () => {}) {
      this.storage = storage; this.appId = appId; this.storageKey = 'financ-vault-v1:' + appId;
      this.onError = onError; this.key = null; this.values = null; this.envelope = null;
      this.pending = null; this.dirty = false; this.lastStored = null; this.closing = false; this.prefs = null;
      this.sessionKey = null; this.session = null;
    }
    get exists() { return this.storage.getItem(this.storageKey) !== null; }
    context(part) { return this.appId + ':vault-v1:' + part; }
    assertOpen() { if (!this.key || !this.values || this.closing) throw new Error('Cofre bloqueado.'); }
    async create(pin, initial = {}, recovery = recoveryCode()) {
      if (this.exists) throw new Error('O cofre já existe.');
      if (!pinOK(pin)) throw new Error('Use um PIN de 6 números.');
      const rawKey = random(32);
      try {
        this.key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
        this.values = Object.assign(Object.create(null), initial);
        await this.sealSession(b64(rawKey));
        this.envelope = { version: 1, appId: this.appId,
          password: await protect(b64(rawKey), pin, this.context('password')),
          recovery: await protectWithSecret(b64(rawKey), recovery, this.context('recovery')) };
        this.dirty = true;
        await this.flush();
        return recovery;
      } catch (error) { this.forget(); throw error; }
      finally { rawKey.fill(0); }
    }
    readEnvelope() {
      const stored = this.storage.getItem(this.storageKey);
      const envelope = JSON.parse(stored);
      if (!envelope || envelope.version !== 1 || envelope.appId !== this.appId) throw new Error('Cofre inválido.');
      return { stored, envelope };
    }
    get biometric() {
      try {
        const { envelope } = this.envelope ? { envelope: this.envelope } : this.readEnvelope();
        const b = envelope.biometric;
        return b ? { credentialId: b.credentialId, prfSalt: b.prfSalt } : null;
      } catch (_) { return null; }
    }
    async unlock(secret, recovery = false) {
      const { stored, envelope } = this.readEnvelope();
      const kind = recovery ? 'recovery' : 'password';
      await this.openWith(await unprotect(envelope[kind], secret, this.context(kind)), envelope, stored);
    }
    async unlockBiometric(prfSecret) {
      const { stored, envelope } = this.readEnvelope();
      const b = envelope.biometric;
      if (!b || typeof b.salt !== 'string') throw new Error('Biometria não configurada.');
      const key = await hkdfKey(prfSecret, unb64(b.salt), this.context('biometric'));
      await this.openWith(await open(b, key, this.context('biometric')), envelope, stored);
    }
    async verifyPin(pin) {
      this.assertOpen();
      if (!pinOK(pin)) throw new Error('Use um PIN de 6 números.');
      await unprotect(this.envelope.password, pin, this.context('password'));
    }
    async enableBiometric(pin, credentialId, prfSalt, prfSecret) {
      this.assertOpen();
      if (typeof credentialId !== 'string' || typeof prfSalt !== 'string') throw new Error('Credencial inválida.');
      // O PIN autoriza a operação e libera a chave bruta, que é embrulhada pela biometria.
      const raw = await unprotect(this.envelope.password, pin, this.context('password'));
      const salt = random(16);
      const key = await hkdfKey(prfSecret, salt, this.context('biometric'));
      this.envelope.biometric = { credentialId, prfSalt, salt: b64(salt), ...await seal(raw, key, this.context('biometric')) };
      this.dirty = true; await this.flush();
    }
    get settings() { return this.prefs ? { ...this.prefs } : { ...DEFAULT_SETTINGS }; }
    async setSettings(partial) {
      this.assertOpen();
      if (partial.autoLockMinutes !== undefined && !AUTO_LOCK_MINUTES.includes(partial.autoLockMinutes)) throw new Error('Tempo de bloqueio inválido.');
      if (partial.lockOnHide !== undefined && typeof partial.lockOnHide !== 'boolean') throw new Error('Valor inválido para bloquear ao sair.');
      const next = cleanSettings({ ...this.settings, ...partial });
      this.envelope.settings = await seal(next, this.key, this.context('settings'));
      this.prefs = next;
      this.dirty = true; await this.flush();
      return next;
    }
    async changePin(currentPin, newPin) {
      this.assertOpen();
      if (!pinOK(newPin)) throw new Error('Use um PIN de 6 números.');
      const raw = await unprotect(this.envelope.password, currentPin, this.context('password'));
      this.envelope.password = await protect(raw, newPin, this.context('password'));
      this.dirty = true; await this.flush();
    }
    async rotateRecovery(pin, recovery = recoveryCode()) {
      this.assertOpen();
      const raw = await unprotect(this.envelope.password, pin, this.context('password'));
      this.envelope.recovery = await protectWithSecret(raw, recovery, this.context('recovery'));
      this.dirty = true; await this.flush();
      return recovery;
    }
    async destroy(pin) {
      await this.verifyPin(pin);
      if (this.pending) await this.pending.catch(() => {});
      this.storage.removeItem(this.storageKey);
      this.forget(); this.lastStored = null; this.dirty = false;
    }
    async disableBiometric() {
      this.assertOpen();
      delete this.envelope.biometric;
      this.dirty = true; await this.flush();
    }
    async openWith(rawB64, envelope, stored) {
      const rawKey = unb64(rawB64);
      try {
        const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
        const values = await open(envelope.payload, key, this.context('data'));
        if (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).some(v => typeof v !== 'string')) throw new Error('Dados inválidos.');
        // Preferência adulterada ou ilegível volta ao padrão (15 min, sem bloqueio ao sair).
        let prefs = { ...DEFAULT_SETTINGS };
        if (envelope.settings) { try { prefs = cleanSettings(await open(envelope.settings, key, this.context('settings'))); } catch (_) {} }
        this.prefs = prefs;
        this.key = key; this.values = Object.assign(Object.create(null), values); this.envelope = envelope;
        this.lastStored = stored; this.closing = false;
        await this.sealSession(rawB64);
      } finally { rawKey.fill(0); }
    }
    // Sessão da aba: a chave bruta é cifrada por uma chave de sessão não-exportável (fornecida pela interface),
    // para reabrir o cofre ao recarregar a página sem pedir o PIN. Só o blob cifrado sai daqui.
    async sealSession(rawB64) {
      this.session = this.sessionKey ? await seal(rawB64, this.sessionKey, this.context('session')) : null;
    }
    async resume(blob) {
      if (!this.sessionKey) throw new Error('Sessão indisponível.');
      const { stored, envelope } = this.readEnvelope();
      await this.openWith(await open(blob, this.sessionKey, this.context('session')), envelope, stored);
    }
    // O código usado deixa de valer: um novo é gerado e devolvido para ser exibido uma única vez.
    async resetPassword(recovery, newPin, nextRecovery = recoveryCode()) {
      if (!pinOK(newPin)) throw new Error('Use um PIN de 6 números.');
      await this.unlock(recovery, true);
      const raw = await unprotect(this.envelope.recovery, recovery, this.context('recovery'));
      this.envelope.password = await protect(raw, newPin, this.context('password'));
      this.envelope.recovery = await protectWithSecret(raw, nextRecovery, this.context('recovery'));
      this.dirty = true; await this.flush();
      return nextRecovery;
    }
    getItem(name) { this.assertOpen(); return Object.hasOwn(this.values, name) ? this.values[name] : null; }
    setItem(name, value) { this.assertOpen(); this.values[name] = String(value); this.changed(); }
    removeItem(name) { this.assertOpen(); delete this.values[name]; this.changed(); }
    keyAt(index) { this.assertOpen(); return Object.keys(this.values)[index] ?? null; }
    get length() { this.assertOpen(); return Object.keys(this.values).length; }
    changed() { this.dirty = true; this.flush().catch(error => this.onError(error)); }
    async flush() {
      if (this.pending) { await this.pending; if (this.dirty) return this.flush(); return; }
      if (!this.key || !this.dirty) return;
      this.pending = (async () => {
        while (this.dirty) {
          this.dirty = false;
          try {
            const payload = await seal(this.values, this.key, this.context('data'));
            if (this.storage.getItem(this.storageKey) !== this.lastStored) throw new Error('O cofre mudou em outra aba. Reabra o aplicativo.');
            const next = JSON.stringify({ ...this.envelope, payload });
            this.storage.setItem(this.storageKey, next);
            if (this.storage.getItem(this.storageKey) !== next) throw new Error('Falha ao confirmar a gravação.');
            this.lastStored = next; this.envelope.payload = payload;
          } catch (error) { this.dirty = true; throw error; }
        }
      })();
      try { await this.pending; } finally { this.pending = null; }
    }
    cleanupLegacy(matches) {
      this.assertOpen();
      // Only remove originals identical to the successfully encrypted snapshot.
      if (this.dirty || this.pending || !this.lastStored) throw new Error('Migração ainda não salva.');
      const keys = Array.from({ length: this.storage.length }, (_, i) => this.storage.key(i));
      for (const key of keys) if (matches(key) && this.storage.getItem(key) === this.getItem(key)) this.storage.removeItem(key);
    }
    forget() { this.key = null; this.values = null; this.envelope = null; this.prefs = null; this.session = null; this.closing = false; }
    async lock() { this.closing = true; try { await this.flush(); this.forget(); } catch (error) { this.closing = false; throw error; } }
  }

  // WebAuthn com extensão PRF. Sem servidor: a segurança vem do segredo PRF, que o autenticador
  // só entrega após verificação do usuário (digital, rosto ou bloqueio de tela).
  const b64url = s => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const webauthn = {
    async available() {
      if (typeof window === 'undefined' || !window.PublicKeyCredential || !window.isSecureContext || !navigator.credentials) return false;
      // WebAuthn exige nome de domínio (HTTPS ou localhost); endereços IP são recusados pelo navegador.
      if (/^[\d.]+$|^\[|:/.test(location.hostname)) return false;
      try {
        if (PublicKeyCredential.getClientCapabilities) {
          const caps = await PublicKeyCredential.getClientCapabilities();
          if (caps['extension:prf'] === false) return false;
        }
        return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      } catch (_) { return false; }
    },
    async enroll(appName, appId) {
      const prfSalt = random(32);
      const credential = await navigator.credentials.create({ publicKey: {
        rp: { name: appName }, challenge: random(32),
        user: { id: random(16), name: appName + ' (' + appId + ')', displayName: appName },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        // Android: o Chrome só entrega PRF para passkeys (credenciais residentes) do Gerenciador de Senhas do Google.
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required', requireResidentKey: true },
        timeout: 60000, extensions: { prf: { eval: { first: prfSalt } } },
      } });
      const prf = credential.getClientExtensionResults().prf;
      if (!prf || prf.enabled === false) throw new Error('Este aparelho não oferece biometria com criptografia. Continue usando o PIN.');
      const credentialId = b64(credential.rawId);
      // Alguns navegadores só devolvem o segredo PRF numa autenticação, não no cadastro.
      const secret = prf.results && prf.results.first ? new Uint8Array(prf.results.first) : await webauthn.evaluate(credentialId, b64(prfSalt));
      return { credentialId, prfSalt: b64(prfSalt), secret };
    },
    async evaluate(credentialId, prfSalt) {
      const assertion = await navigator.credentials.get({ publicKey: {
        challenge: random(32), timeout: 60000, userVerification: 'required',
        allowCredentials: [{ type: 'public-key', id: unb64(credentialId), transports: ['internal', 'hybrid'] }],
        extensions: { prf: { eval: { first: unb64(prfSalt) } } },
      } });
      const prf = assertion.getClientExtensionResults().prf;
      if (!prf || !prf.results || !prf.results.first) throw new Error('A biometria não liberou a chave neste navegador. Use o PIN.');
      return new Uint8Array(prf.results.first);
    },
    forget(credentialId) {
      // Pede ao navegador para remover a credencial órfã (Chrome 132+); ignorado onde não existe.
      try { PublicKeyCredential.signalUnknownCredential({ rpId: location.hostname, credentialId: b64url(credentialId) }).catch(() => {}); } catch (_) {}
    },
  };
  const api = { Vault, protect, unprotect, pinOK, recoveryCode, webauthn, AUTO_LOCK_MINUTES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FinancVault = api;
})(globalThis);
