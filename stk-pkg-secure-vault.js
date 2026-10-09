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
  // Arquivos exportados (backup, certificado): senha longa, porque o arquivo pode ir parar em qualquer lugar
  // e um PIN de 6 números cai rápido em força bruta offline.
  const PASSPHRASE_MIN = 10;
  const passphraseOK = s => typeof s === 'string' && s.length >= PASSPHRASE_MIN;
  async function protectPassphrase(value, passphrase, context) {
    if (!passphraseOK(passphrase)) throw new Error('Use uma senha com pelo menos ' + PASSPHRASE_MIN + ' caracteres.');
    return protectWithSecret(value, passphrase, context);
  }
  async function unprotect(payload, pin, context) {
    if (!payload || payload.format !== 'financ-encrypted-v1' || payload.context !== context || payload.iterations !== ITERATIONS) throw new Error('Formato incompatível.');
    const salt = unb64(payload.salt);
    if (salt.length !== 16) throw new Error('Formato inválido.');
    return open(payload, await derive(pin, salt), context);
  }
  // Preferências cifradas e autenticadas com a chave de dados (só existem com o cofre aberto); só valores da lista são aceitos.
  const AUTO_LOCK_MINUTES = [1, 5, 15, 30];
  const DEFAULT_SETTINGS = Object.freeze({ autoLockMinutes: 5, lockOnHide: false });
  function cleanSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      autoLockMinutes: AUTO_LOCK_MINUTES.includes(s.autoLockMinutes) ? s.autoLockMinutes : DEFAULT_SETTINGS.autoLockMinutes,
      lockOnHide: s.lockOnHide === true,
    };
  }
  function recoveryCode() { return Array.from(random(32), n => n.toString(16).padStart(2, '0')).join('').match(/.{8}/g).join('-'); }
  const importAes = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

  // 12 palavras (BIP39, lista em português) → hash de 12 caracteres → raiz.
  // As palavras são só a forma de escrever o hash; o hash sozinho abre tudo (recuperar o PIN, certificado, backups).
  // A raiz vem do hash por derivação lenta (PBKDF2, 600 mil): tentar hashes no arquivo de backup fica inviável.
  const wordlist = () => root.FINANC_BIP39_PT || (typeof require === 'function' ? require('./stk-pkg-bip39-pt.js') : null);
  const HASH_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: sem I, L, O, U (não confunde com 1 e 0)
  const sha256 = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const bitsOf = bytes => Array.from(bytes, b => b.toString(2).padStart(8, '0')).join('');
  const plain = text => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const seedError = message => Object.assign(new Error(message), { code: 'SEED_INVALID' });
  async function wordsFromEntropy(entropy) {
    if (!(entropy instanceof Uint8Array) || entropy.length !== 16) throw new Error('Semente inválida.');
    const list = wordlist(), bits = bitsOf(entropy) + bitsOf(await sha256(entropy)).slice(0, 4);
    return bits.match(/.{11}/g).map(chunk => list[parseInt(chunk, 2)]);
  }
  // Aceita maiúsculas, acentos, vírgulas e só as 4 primeiras letras de cada palavra (são únicas na lista).
  async function entropyFromWords(text) {
    const list = wordlist(), typed = plain(text).split(/[^a-z]+/).filter(Boolean);
    if (typed.length !== 12) throw seedError('Digite as 12 palavras (foram ' + typed.length + ').');
    const bits = typed.map((word, i) => {
      let index = list.indexOf(word);
      if (index < 0 && word.length >= 4) { const hits = list.filter(w => w.startsWith(word.slice(0, 4))); if (hits.length === 1) index = list.indexOf(hits[0]); }
      if (index < 0) throw seedError('A palavra ' + (i + 1) + ' ("' + word + '") não existe na lista.');
      return index.toString(2).padStart(11, '0');
    }).join('');
    const entropy = Uint8Array.from(bits.slice(0, 128).match(/.{8}/g), b => parseInt(b, 2));
    if (bitsOf(await sha256(entropy)).slice(0, 4) !== bits.slice(128)) throw seedError('As 12 palavras não conferem. Verifique a ordem e a escrita.');
    return entropy;
  }
  async function hashFromEntropy(entropy) {
    const digest = await sha256(new Uint8Array([...enc.encode('financ-hash-v1:'), ...entropy]));
    return bitsOf(digest).slice(0, 60).match(/.{5}/g).map(b => HASH_ALPHABET[parseInt(b, 2)]).join('');
  }
  const formatHash = hash => hash.match(/.{4}/g).join('-');
  function normalizeHash(text) {
    const h = String(text).toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    if (h.length !== 12 || [...h].some(c => !HASH_ALPHABET.includes(c))) throw seedError('O código tem 12 caracteres (letras e números).');
    return h;
  }
  // O que a pessoa digitou na recuperação: 12 palavras, o hash de 12 caracteres ou o código antigo (64 hexadecimais).
  async function parseSecret(text) {
    const raw = String(text || '').trim();
    if (/^[0-9a-f]{8}(-[0-9a-f]{8}){7}$/i.test(raw)) return { kind: 'code', code: raw.toLowerCase() };
    if (raw.split(/[\s,;]+/).filter(Boolean).length >= 6) return { kind: 'words', hash: await hashFromEntropy(await entropyFromWords(raw)) };
    return { kind: 'hash', hash: normalizeHash(raw) };
  }
  async function rootFromHash(hash) {
    const material = await crypto.subtle.importKey('raw', enc.encode('financ-root-v1:' + normalizeHash(hash)), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode('financ-root-v1'), iterations: ITERATIONS, hash: 'SHA-256' }, material, 256));
  }
  async function rootBits(rootBytes, info, length = 256, salt = enc.encode('financ-seed-v1')) {
    const material = await crypto.subtle.importKey('raw', rootBytes, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, material, length));
  }
  const rootKey = async (rootBytes, info, salt) => importAes(await rootBits(rootBytes, info, 256, salt));
  // Certificado: sai da raiz (sempre o mesmo para as mesmas palavras), não do PIN.
  async function certFromRoot(rootBytes) {
    const id = 'cert-' + Array.from(await rootBits(rootBytes, 'financ:cert-id', 80), b => HASH_ALPHABET[b & 31]).join('').toLowerCase();
    return { version: 1, id, secret: b64(await rootBits(rootBytes, 'financ:cert-secret')), createdAt: new Date().toISOString(), seed: true };
  }
  // Backup v2: chave = raiz + certificado, sal novo por arquivo. Abre com as 12 palavras ou o hash, sem senha extra.
  const BACKUP_FORMAT = 'financ-backup-v2';
  async function backupKey(rootBytes, cert, salt, context) {
    return rootKey(new Uint8Array([...rootBytes, ...unb64(cert.secret)]), BACKUP_FORMAT + ':' + context, salt);
  }
  async function sealBackup(value, context, rootBytes) {
    const cert = await certFromRoot(rootBytes), salt = random(16);
    return { format: BACKUP_FORMAT, context, certId: cert.id, salt: b64(salt), ...await seal(value, await backupKey(rootBytes, cert, salt, context), context) };
  }
  async function openBackup(payload, context, rootBytes) {
    if (!payload || payload.format !== BACKUP_FORMAT || payload.context !== context || typeof payload.salt !== 'string') throw new Error('Formato incompatível.');
    const cert = await certFromRoot(rootBytes);
    if (cert.id !== payload.certId) throw Object.assign(new Error('Este backup é de outras 12 palavras.'), { code: 'SEED_REQUIRED' });
    return open(payload, await backupKey(rootBytes, cert, unb64(payload.salt), context), context);
  }
  const seed = { wordsFromEntropy, entropyFromWords, hashFromEntropy, formatHash, normalizeHash, parseSecret, rootFromHash, certFromRoot, sealBackup, openBackup, BACKUP_FORMAT };

  // FINANC ID: um PIN, um código de recuperação, uma biometria e os certificados valem para todos os apps
  // do mesmo endereço (mesma origem = mesmo localStorage). Guarda uma chave principal aleatória, protegida
  // pelo PIN, pelo código e pela biometria; cada app guarda a própria chave de dados embrulhada por ela.
  const ID_KEY = 'financ-id-v1';
  const idContext = part => 'financ-id:v1:' + part;
  const certOK = c => c && typeof c.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(c.id) && typeof c.secret === 'string' && (() => { try { return atob(c.secret).length === 32; } catch (_) { return false; } })();
  const cleanCert = c => ({ version: 1, id: c.id, secret: c.secret, createdAt: c.createdAt || new Date().toISOString() });
  class Identity {
    constructor(storage) { this.storage = storage; this.onWrite = () => {}; }
    get exists() { return this.storage.getItem(ID_KEY) !== null; }
    read() {
      const record = JSON.parse(this.storage.getItem(ID_KEY));
      if (!record || record.version !== 1 || !record.password || !record.recovery) throw new Error('FINANC ID inválido.');
      return record;
    }
    // Relê antes de gravar: outro app pode ter mudado o registro (PIN, biometria, certificados).
    write(change) {
      const record = this.exists ? this.read() : { version: 1 };
      change(record);
      // Identificador fixo (não secreto): permite saber se um backup em arquivo é deste mesmo FINANC ID.
      if (typeof record.uid !== 'string') record.uid = b64(random(16));
      const next = JSON.stringify(record);
      this.storage.setItem(ID_KEY, next);
      if (this.storage.getItem(ID_KEY) !== next) throw new Error('Falha ao gravar o FINANC ID.');
      try { this.onWrite(); } catch (_) {}
      return record;
    }
    // Cria com uma semente nova: devolve { master, words, hash, rootBytes } (palavras e hash: mostrar uma vez).
    async create(pin) {
      if (this.exists) throw new Error('O FINANC ID já existe.');
      const raw = random(32);
      try {
        const master = b64(raw);
        const password = await protect(master, pin, idContext('password'));
        const parts = await this.seedParts(master, random(16), []);
        this.write(r => { r.password = password; r.recovery = parts.recovery; r.seed = parts.seed; r.certificates = parts.certificates; });
        return { master, words: parts.words, hash: parts.hash, rootBytes: parts.rootBytes };
      } finally { raw.fill(0); }
    }
    get hasSeed() { try { return Boolean(this.read().seed); } catch (_) { return false; } }
    // Semente cifrada pela chave principal; recuperação do PIN pela raiz das palavras; certificado da semente
    // como atual (os anteriores ficam na lista para abrir backups antigos).
    async seedParts(master, entropy, previousCerts) {
      const hash = await hashFromEntropy(entropy), rootBytes = await rootFromHash(hash);
      const raw = unb64(master);
      let masterKey; try { masterKey = await importAes(raw); } finally { raw.fill(0); }
      const cert = await certFromRoot(rootBytes);
      const certs = [cert, ...previousCerts.filter(c => c.id !== cert.id)].map(cleanCert);
      return {
        recovery: { format: 'financ-seed-v1', ...await seal(master, await rootKey(rootBytes, idContext('recovery')), idContext('recovery')) },
        seed: await seal(b64(entropy), masterKey, idContext('seed')),
        certificates: await seal(certs, masterKey, idContext('certificates')),
        words: await wordsFromEntropy(entropy), hash: formatHash(hash), rootBytes,
      };
    }
    // Troca a semente (migração do código antigo ou "gerar novas 12 palavras"). Devolve { words, hash, rootBytes }.
    async setSeed(master, entropy) {
      const raw = unb64(master);
      let masterKey; try { masterKey = await importAes(raw); } finally { raw.fill(0); }
      let previous = []; try { previous = await this.certificates(masterKey); } catch (_) {}
      const parts = await this.seedParts(master, entropy, previous);
      this.write(r => { r.recovery = parts.recovery; r.seed = parts.seed; r.certificates = parts.certificates; });
      return { words: parts.words, hash: parts.hash, rootBytes: parts.rootBytes };
    }
    async seed(masterKey) { const sealed = this.read().seed; return sealed ? unb64(await open(sealed, masterKey, idContext('seed'))) : null; }
    // 'pin' (6 números) ou 'password' (senha longa, opcional e mais forte contra força bruta offline).
    get kind() { try { return this.read().secretKind === 'password' ? 'password' : 'pin'; } catch (_) { return 'pin'; } }
    withPin(pin) { return unprotect(this.read().password, pin, idContext('password')); }
    // 12 palavras ou hash (FINANC ID com semente); código de 8 blocos só em FINANC ID ainda não migrado.
    async withRecovery(text) {
      const rec = this.read().recovery, secret = await parseSecret(text);
      if (rec.format === 'financ-seed-v1') {
        if (secret.kind === 'code') throw seedError('Este aparelho usa as 12 palavras. O código antigo de 8 blocos não vale mais.');
        return open(rec, await rootKey(await rootFromHash(secret.hash), idContext('recovery')), idContext('recovery'));
      }
      if (secret.kind !== 'code') throw seedError('Este aparelho ainda usa o código de recuperação antigo (8 blocos).');
      return unprotect(rec, secret.code, idContext('recovery'));
    }
    async withBiometric(prfSecret) {
      const b = this.read().biometric;
      if (!b || typeof b.salt !== 'string') throw new Error('Biometria não configurada.');
      return open(b, await hkdfKey(prfSecret, unb64(b.salt), idContext('biometric')), idContext('biometric'));
    }
    get biometric() {
      try { const b = this.read().biometric; return b ? { credentialId: b.credentialId, prfSalt: b.prfSalt } : null; } catch (_) { return null; }
    }
    async setPin(master, secret, kind = 'pin') {
      const password = kind === 'password' ? await protectPassphrase(master, secret, idContext('password')) : await protect(master, secret, idContext('password'));
      this.write(r => { r.password = password; if (kind === 'password') r.secretKind = 'password'; else delete r.secretKind; });
    }
    async setBiometric(master, credentialId, prfSalt, prfSecret) {
      const salt = random(16);
      const sealed = await seal(master, await hkdfKey(prfSecret, salt, idContext('biometric')), idContext('biometric'));
      this.write(r => { r.biometric = { credentialId, prfSalt, salt: b64(salt), ...sealed }; });
    }
    clearBiometric() { this.write(r => { delete r.biometric; }); }
    async certificates(masterKey) {
      const sealed = this.read().certificates;
      if (!sealed) return [];
      const list = await open(sealed, masterKey, idContext('certificates'));
      return Array.isArray(list) ? list.filter(certOK).map(cleanCert) : [];
    }
    async setCertificates(masterKey, list) {
      const sealed = await seal(list.map(cleanCert), masterKey, idContext('certificates'));
      this.write(r => { r.certificates = sealed; });
    }
  }

  class Vault {
    constructor(storage, appId, onError = () => {}) {
      this.storage = storage; this.appId = appId; this.storageKey = 'financ-vault-v1:' + appId;
      this.onError = onError; this.key = null; this.values = null; this.envelope = null;
      this.pending = null; this.dirty = false; this.lastStored = null; this.closing = false; this.prefs = null;
      this.sessionKey = null; this.session = null; this.onStored = () => {};
      this.identity = new Identity(storage); this.masterKey = null; this.certs = null; this.root = null;
    }
    get exists() { return this.storage.getItem(this.storageKey) !== null; }
    // Segredo de abertura: PIN de 6 números ou senha longa (só com o FINANC ID).
    get secretKind() { return this.linked || (!this.exists && this.identity.exists) ? this.identity.kind : 'pin'; }
    secretOK(secret) { return this.secretKind === 'password' ? passphraseOK(secret) : pinOK(secret); }
    // Cofre ligado ao FINANC ID: não tem PIN, código nem biometria próprios.
    get linked() {
      try { const { envelope } = this.envelope ? { envelope: this.envelope } : this.readEnvelope(); return Boolean(envelope.identity); } catch (_) { return false; }
    }
    context(part) { return this.appId + ':vault-v1:' + part; }
    assertOpen() { if (!this.key || !this.values || this.closing) throw new Error('Cofre bloqueado.'); }
    // Sem FINANC ID: cria um com este PIN e devolve { words, hash } (exibir uma vez).
    // Com FINANC ID: o PIN é o dele e não há palavras novas (devolve null).
    async create(pin, initial = {}) {
      if (this.exists) throw new Error('O cofre já existe.');
      const hadIdentity = this.identity.exists;
      if (hadIdentity ? typeof pin !== 'string' || !pin : !pinOK(pin)) throw new Error('Use um PIN de 6 números.');
      const created = hadIdentity ? null : await this.identity.create(pin);
      const master = created ? created.master : await this.identity.withPin(pin);
      if (created) this.root = created.rootBytes;
      const rawKey = random(32);
      try {
        this.key = await importAes(rawKey);
        this.values = Object.assign(Object.create(null), initial);
        await this.useMaster(master);
        this.envelope = { version: 1, appId: this.appId, identity: await seal(b64(rawKey), this.masterKey, this.context('identity')) };
        await this.sealSession(b64(rawKey), master);
        this.dirty = true;
        await this.flush();
        return created ? { words: created.words, hash: created.hash } : null;
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
      if (this.linked) return this.identity.biometric;
      try {
        const { envelope } = this.envelope ? { envelope: this.envelope } : this.readEnvelope();
        const b = envelope.biometric;
        return b ? { credentialId: b.credentialId, prfSalt: b.prfSalt } : null;
      } catch (_) { return null; }
    }
    async useMaster(master) {
      const raw = unb64(master);
      try { this.masterKey = await importAes(raw); } finally { raw.fill(0); }
      try { this.certs = await this.identity.certificates(this.masterKey); } catch (_) { this.certs = []; }
    }
    async openLinked(master, envelope, stored) {
      await this.useMaster(master);
      await this.openWith(await open(envelope.identity, this.masterKey, this.context('identity')), envelope, stored, master);
    }
    // Abre com o PIN. Devolve o que a interface precisa fazer em seguida:
    //   { seed }             FINANC ID criado ou migrado agora: mostrar as 12 palavras e o hash uma vez.
    //   { recovery }         app com PIN próprio: código antigo dele, renovado (mostrar uma vez).
    //   { needsIdentityPin } app aberto com o PIN antigo, mas o FINANC ID tem outro PIN: pedir o PIN FINANC.
    // Erro 'LEGACY_PIN': o PIN é o do FINANC ID, mas este app ainda usa o PIN antigo dele.
    async unlock(secret, recovery = false) {
      const { stored, envelope } = this.readEnvelope();
      if (envelope.identity) {
        const master = recovery ? await this.identity.withRecovery(secret) : await this.identity.withPin(secret);
        await this.openLinked(master, envelope, stored);
        return this.ensureSeed(master);
      }
      const kind = recovery ? 'recovery' : 'password';
      if (recovery) secret = String(secret).trim().toLowerCase();
      try {
        await this.openWith(await unprotect(envelope[kind], secret, this.context(kind)), envelope, stored);
      } catch (error) {
        if (recovery || error.name !== 'OperationError' || !this.identity.exists) throw error;
        await this.identity.withPin(secret); // PIN FINANC certo, PIN antigo do app diferente.
        const legacy = new Error('Digite o PIN antigo deste app uma única vez para ligá-lo ao PIN FINANC.'); legacy.code = 'LEGACY_PIN';
        throw legacy;
      }
      return recovery ? {} : this.linkAfterLegacy(secret);
    }
    async linkAfterLegacy(pin) {
      if (!this.identity.exists) {
        const created = await this.identity.create(pin);
        await this.link(created.master); this.root = created.rootBytes;
        return { seed: { words: created.words, hash: created.hash } };
      }
      try { const master = await this.identity.withPin(pin); await this.link(master); return this.ensureSeed(master); }
      catch (error) { if (error.name === 'OperationError') return { needsIdentityPin: true }; throw error; }
    }
    // Com o app aberto pelo PIN antigo: liga ao FINANC ID usando o PIN FINANC.
    async linkWithIdentityPin(pin) { this.assertOpen(); const master = await this.identity.withPin(pin); await this.link(master); return this.ensureSeed(master); }
    // FINANC ID antigo (código de 8 blocos): ganha as 12 palavras na primeira abertura. Devolve { seed } ou {}.
    async ensureSeed(master) {
      if (this.identity.hasSeed) return {};
      const made = await this.identity.setSeed(master, random(16));
      await this.useMaster(master); this.root = made.rootBytes;
      return { seed: { words: made.words, hash: made.hash } };
    }
    // PIN FINANC digitado primeiro (erro LEGACY_PIN): abre com o PIN antigo e liga.
    async unlockLegacy(oldPin, identityPin) {
      const { stored, envelope } = this.readEnvelope();
      const master = await this.identity.withPin(identityPin);
      await this.openWith(await unprotect(envelope.password, oldPin, this.context('password')), envelope, stored);
      await this.link(master);
      return this.ensureSeed(master);
    }
    // Troca PIN, código e biometria próprios do app pela chave embrulhada pelo FINANC ID.
    async link(master) {
      this.assertOpen();
      const appRaw = this.rawForLink;
      if (!appRaw) throw new Error('Cofre bloqueado.');
      await this.useMaster(master);
      const next = { version: 1, appId: this.appId, identity: await seal(appRaw, this.masterKey, this.context('identity')) };
      if (this.envelope.settings) next.settings = this.envelope.settings;
      if (this.envelope.payload) next.payload = this.envelope.payload;
      this.envelope = next;
      this.rawForLink = null;
      await this.sealSession(appRaw, master);
      this.dirty = true; await this.flush();
    }
    async unlockBiometric(prfSecret) {
      const { stored, envelope } = this.readEnvelope();
      if (envelope.identity) { const master = await this.identity.withBiometric(prfSecret); await this.openLinked(master, envelope, stored); return this.ensureSeed(master); }
      const b = envelope.biometric;
      if (!b || typeof b.salt !== 'string') throw new Error('Biometria não configurada.');
      const key = await hkdfKey(prfSecret, unb64(b.salt), this.context('biometric'));
      await this.openWith(await open(b, key, this.context('biometric')), envelope, stored);
      return {};
    }
    async masterFromPin(pin) {
      if (typeof pin !== 'string' || !pin) throw new Error('Digite o PIN ou a senha.');
      return this.identity.withPin(pin);
    }
    async verifyPin(pin) {
      this.assertOpen();
      if (this.linked) { await this.masterFromPin(pin); return; }
      if (!pinOK(pin)) throw new Error('Use um PIN de 6 números.');
      await unprotect(this.envelope.password, pin, this.context('password'));
    }
    async enableBiometric(pin, credentialId, prfSalt, prfSecret) {
      this.assertOpen();
      if (typeof credentialId !== 'string' || typeof prfSalt !== 'string') throw new Error('Credencial inválida.');
      if (this.linked) { await this.identity.setBiometric(await this.masterFromPin(pin), credentialId, prfSalt, prfSecret); return; }
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
      if (this.linked) {
        const kind = this.secretKind;
        if (!this.secretOK(newPin)) throw new Error(kind === 'password' ? 'Use uma senha com pelo menos ' + PASSPHRASE_MIN + ' caracteres.' : 'Use um PIN de 6 números.');
        await this.identity.setPin(await this.masterFromPin(currentPin), newPin, kind); return;
      }
      if (!pinOK(newPin)) throw new Error('Use um PIN de 6 números.');
      const raw = await unprotect(this.envelope.password, currentPin, this.context('password'));
      this.envelope.password = await protect(raw, newPin, this.context('password'));
      this.dirty = true; await this.flush();
    }
    // Troca PIN por senha longa (ou volta ao PIN). Vale para todos os apps ligados ao FINANC ID.
    async changeSecretKind(current, next, kind) {
      this.assertOpen();
      if (!this.linked) throw new Error('Ligue este app ao PIN único para usar senha.');
      if (kind !== 'pin' && kind !== 'password') throw new Error('Tipo inválido.');
      await this.identity.setPin(await this.masterFromPin(current), next, kind);
    }
    // Ligado ao FINANC ID: gera novas 12 palavras e devolve { words, hash }. As palavras antigas deixam de recuperar o PIN;
    // o certificado antigo fica guardado (backups antigos continuam abrindo neste aparelho).
    // App com PIN próprio: devolve um código novo de 8 blocos (formato antigo).
    async rotateRecovery(pin, recovery = recoveryCode()) {
      this.assertOpen();
      if (this.linked) {
        const master = await this.masterFromPin(pin), made = await this.identity.setSeed(master, random(16));
        await this.useMaster(master); this.root = made.rootBytes;
        return { words: made.words, hash: made.hash };
      }
      const raw = await unprotect(this.envelope.password, pin, this.context('password'));
      this.envelope.recovery = await protectWithSecret(raw, recovery, this.context('recovery'));
      this.dirty = true; await this.flush();
      return recovery;
    }
    // Apaga só o cofre deste app; o FINANC ID continua valendo para os outros.
    async destroy(pin) {
      await this.verifyPin(pin);
      if (this.pending) await this.pending.catch(() => {});
      this.storage.removeItem(this.storageKey);
      this.forget(); this.lastStored = null; this.dirty = false;
    }
    async disableBiometric() {
      this.assertOpen();
      if (this.linked) { this.identity.clearBiometric(); return; }
      delete this.envelope.biometric;
      this.dirty = true; await this.flush();
    }
    async openWith(rawB64, envelope, stored, master = null) {
      const rawKey = unb64(rawB64);
      try {
        const key = await importAes(rawKey);
        const values = envelope.payload ? await open(envelope.payload, key, this.context('data')) : {};
        if (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).some(v => typeof v !== 'string')) throw new Error('Dados inválidos.');
        // Preferência adulterada ou ilegível volta ao padrão (5 min, sem bloqueio ao sair).
        let prefs = { ...DEFAULT_SETTINGS };
        if (envelope.settings) { try { prefs = cleanSettings(await open(envelope.settings, key, this.context('settings'))); } catch (_) {} }
        this.prefs = prefs;
        this.key = key; this.values = Object.assign(Object.create(null), values); this.envelope = envelope;
        this.lastStored = stored; this.closing = false;
        this.rawForLink = envelope.identity ? null : rawB64;
        await this.sealSession(rawB64, master);
      } finally { rawKey.fill(0); }
    }
    // Sessão da aba: as chaves brutas são cifradas por uma chave de sessão não-exportável (fornecida pela interface),
    // para reabrir o cofre ao recarregar a página sem pedir o PIN. Só o blob cifrado sai daqui.
    async sealSession(rawB64, master = null) {
      this.session = this.sessionKey ? await seal(master ? { k: rawB64, m: master } : rawB64, this.sessionKey, this.context('session')) : null;
    }
    async resume(blob) {
      if (!this.sessionKey) throw new Error('Sessão indisponível.');
      const { stored, envelope } = this.readEnvelope();
      const saved = await open(blob, this.sessionKey, this.context('session'));
      if (saved && typeof saved === 'object' && typeof saved.k === 'string' && typeof saved.m === 'string') {
        if (!envelope.identity) throw new Error('Sessão inválida.');
        await this.useMaster(saved.m);
        await this.openWith(saved.k, envelope, stored, saved.m);
        // Reaberto sem PIN: a migração para as 12 palavras fica para finishMigration (depois de a sessão ser aceita).
        if (!this.identity.hasSeed) this.pendingMaster = saved.m;
      } else if (typeof saved === 'string' && !envelope.identity) await this.openWith(saved, envelope, stored);
      else throw new Error('Sessão inválida.');
    }
    // Com as 12 palavras (ou o hash) define um PIN novo. As palavras continuam as mesmas (backups seguem abrindo).
    // FINANC ID ainda com código antigo: o código vira 12 palavras novas. Devolve { seed?, recovery?, needsIdentityPin? }.
    // Sem cofre deste app ainda, redefine o PIN FINANC e cria o cofre.
    async resetPassword(recovery, newPin, nextRecovery = recoveryCode(), initial = {}) {
      if (!pinOK(newPin)) throw new Error('Use um PIN de 6 números.');
      if (!this.exists || this.linked) {
        const master = await this.identity.withRecovery(recovery);
        await this.identity.setPin(master, newPin);
        const status = this.identity.hasSeed ? {} : await (async () => {
          const made = await this.identity.setSeed(master, random(16));
          return { seed: { words: made.words, hash: made.hash } };
        })();
        if (this.exists) await this.unlock(newPin); else await this.create(newPin, initial);
        return status;
      }
      // App ainda com PIN próprio: abre com o código dele e tenta ligar ao FINANC ID com o novo PIN.
      const code = String(recovery).trim().toLowerCase();
      await this.unlock(code, true);
      const status = await this.linkAfterLegacy(newPin);
      if (!status.needsIdentityPin) return status; // { seed } se criou ou migrou o FINANC ID; {} se ligou ao existente
      const raw = await unprotect(this.envelope.recovery, code, this.context('recovery'));
      this.envelope.password = await protect(raw, newPin, this.context('password'));
      this.envelope.recovery = await protectWithSecret(raw, nextRecovery, this.context('recovery'));
      this.dirty = true; await this.flush();
      return { recovery: nextRecovery, needsIdentityPin: true };
    }
    // Raiz das 12 palavras (só na memória, com o cofre aberto): calculada uma vez por sessão.
    async rootBytes() {
      this.assertOpen();
      if (this.root) return this.root;
      if (!this.masterKey) throw new Error('Ligue este app ao PIN único para usar as 12 palavras.');
      const entropy = await this.identity.seed(this.masterKey);
      if (!entropy) throw new Error('Este aparelho ainda não tem as 12 palavras. Bloqueie e abra de novo com o PIN.');
      try { this.root = await rootFromHash(await hashFromEntropy(entropy)); } finally { entropy.fill(0); }
      return this.root;
    }
    get hasSeed() { return Boolean(this.masterKey && this.identity.hasSeed); }
    // Sessão reaberta sem PIN num FINANC ID ainda sem palavras: cria agora. Devolve { seed } ou {}.
    async finishMigration() {
      const master = this.pendingMaster; this.pendingMaster = null;
      return master && this.key ? this.ensureSeed(master) : {};
    }
    // Mostra as palavras de novo (pede o PIN). Sem palavras ainda (FINANC ID antigo), cria agora.
    async revealSeed(pin) {
      this.assertOpen();
      const master = await this.masterFromPin(pin);
      if (!this.identity.hasSeed) return (await this.ensureSeed(master)).seed;
      const raw = unb64(master);
      let key; try { key = await importAes(raw); } finally { raw.fill(0); }
      const entropy = await this.identity.seed(key);
      if (!entropy) throw new Error('Este aparelho ainda não tem as 12 palavras.');
      try { return { words: await wordsFromEntropy(entropy), hash: formatHash(await hashFromEntropy(entropy)) }; } finally { entropy.fill(0); }
    }
    // Backup v2: cifrado pela raiz das 12 palavras + certificado, sem senha extra.
    async exportBackup(value, context) { return sealBackup(value, context, await this.rootBytes()); }
    // Sem segredo: usa as palavras deste aparelho (erro SEED_REQUIRED se o backup é de outras palavras).
    async importBackup(payload, context, secretText) {
      this.assertOpen();
      if (!secretText) return openBackup(payload, context, await this.rootBytes());
      const secret = await parseSecret(secretText);
      if (secret.kind === 'code') throw seedError('Digite as 12 palavras ou o código de 12 caracteres.');
      const rootOther = await rootFromHash(secret.hash);
      try { return await openBackup(payload, context, rootOther); }
      catch (error) { if (error.code === 'SEED_REQUIRED') throw seedError('Essas palavras não abrem este backup.'); throw error; }
      finally { rootOther.fill(0); }
    }
    // Certificados FINANC (compartilhados). Só com o cofre aberto e ligado ao FINANC ID.
    get certificates() { return this.certs ? this.certs.map(c => ({ ...c })) : []; }
    async saveCertificates(list) {
      this.assertOpen();
      if (!this.masterKey) throw new Error('Ligue este app ao PIN FINANC para usar o certificado.');
      await this.identity.setCertificates(this.masterKey, list);
      this.certs = list.map(cleanCert);
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
            try { this.onStored(); } catch (_) {}
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
    forget() { this.key = null; this.values = null; this.envelope = null; this.prefs = null; this.session = null; this.closing = false; this.masterKey = null; this.certs = null; this.rawForLink = null; if (this.root) this.root.fill(0); this.root = null; this.pendingMaster = null; }
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
  const api = { Vault, Identity, protect, protectPassphrase, passphraseOK, PASSPHRASE_MIN, unprotect, pinOK, recoveryCode, webauthn, AUTO_LOCK_MINUTES, certOK, seed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FinancVault = api;
})(globalThis);
