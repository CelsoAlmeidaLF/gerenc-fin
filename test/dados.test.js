// Armazenamento e segurança dos dados locais (kit 2.1): lembrete de backup, cópia de um app e de todos os apps,
// dados no IndexedDB com migração e contador de PIN que não zera ao recarregar.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const kit = ['../stk-pkt-secure-vault.js', '../src/stk-pkt-secure-vault.js'].map(p => path.join(__dirname, p)).find(p => fs.existsSync(p));
const { Vault, PinGuard } = require(kit);

class MemoryStorage {
  constructor() { this.data = new Map(); }
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}
// IndexedDB de mentira (clona como o navegador faz).
class MapStore {
  constructor() { this.m = new Map(); this.failPut = false; }
  async get(id) { return this.m.has(id) ? structuredClone(this.m.get(id)) : undefined; }
  async put(id, rec) { if (this.failPut) throw Object.assign(new Error('IndexedDB indisponível'), { name: 'UnknownError' }); this.m.set(id, structuredClone(rec)); }
  async delete(id) { this.m.delete(id); }
}
const DAY = 86400000;
const PIN = '482915';
const envelopeOf = (storage, appId) => JSON.parse(storage.getItem('financ-vault-v1:' + appId));

test('dados vão para o IndexedDB; o envelope no localStorage fica sem os dados', async () => {
  const storage = new MemoryStorage(), store = new MapStore();
  const v = new Vault(storage, 'gerenc-fin', () => {}, { dataStore: store });
  await v.create(PIN, { livro: '[1,2,3]' });
  const env = envelopeOf(storage, 'gerenc-fin');
  assert.equal(env.store, 'idb');
  assert.equal(env.payload, undefined);
  assert.equal((await store.get('gerenc-fin')).rev, env.rev);
  await v.lock();
  const w = new Vault(storage, 'gerenc-fin', () => {}, { dataStore: store });
  await w.unlock(PIN);
  assert.equal(w.getItem('livro'), '[1,2,3]');
  assert.equal(w.usage.inIndexedDB, true);
});

test('migração: cofre antigo (dados no localStorage) passa para o IndexedDB no primeiro flush, conferido', async () => {
  const storage = new MemoryStorage(), store = new MapStore();
  const old = new Vault(storage, 'cambio-sim');
  await old.create(PIN, { cambio_log: '["a"]' });
  await old.lock();
  assert.ok(envelopeOf(storage, 'cambio-sim').payload, 'formato antigo com payload');
  const v = new Vault(storage, 'cambio-sim', () => {}, { dataStore: store });
  await v.unlock(PIN);
  assert.equal(v.dirty, true, 'migração agendada');
  await v.flush();
  const env = envelopeOf(storage, 'cambio-sim');
  assert.equal(env.store, 'idb'); assert.equal(env.payload, undefined);
  await v.lock();
  const again = new Vault(storage, 'cambio-sim', () => {}, { dataStore: store });
  await again.unlock(PIN);
  assert.equal(again.getItem('cambio_log'), '["a"]');
});

test('IndexedDB indisponível: continua no localStorage sem perder nada', async () => {
  const storage = new MemoryStorage(), store = new MapStore();
  store.failPut = true;
  const v = new Vault(storage, 'taxometro', () => {}, { dataStore: store });
  await v.create(PIN, { x: '1' });
  const env = envelopeOf(storage, 'taxometro');
  assert.ok(env.payload); assert.equal(env.store, undefined);
  v.setItem('y', '2'); await v.flush(); await v.lock();
  const w = new Vault(storage, 'taxometro');
  await w.unlock(PIN);
  assert.equal(w.getItem('y'), '2');
});

test('queda entre gravar os dados e o envelope: abre com os dados mais novos; IndexedDB apagado avisa', async () => {
  const storage = new MemoryStorage(), store = new MapStore();
  const v = new Vault(storage, 'invest-sim', () => {}, { dataStore: store });
  await v.create(PIN, { s: 'v1' });
  const envBefore = storage.getItem('financ-vault-v1:invest-sim');
  v.setItem('s', 'v2'); await v.flush(); await v.lock();
  storage.setItem('financ-vault-v1:invest-sim', envBefore); // envelope ficou na revisão anterior
  const w = new Vault(storage, 'invest-sim', () => {}, { dataStore: store });
  await w.unlock(PIN);
  assert.equal(w.getItem('s'), 'v2');
  await w.lock();
  await store.delete('invest-sim');
  const z = new Vault(storage, 'invest-sim', () => {}, { dataStore: store });
  await assert.rejects(z.unlock(PIN), e => e.code === 'DATA_MISSING');
});

test('lembrete de backup: só com mudança e prazo vencido; backup e adiar zeram', async () => {
  const storage = new MemoryStorage();
  const v = new Vault(storage, 'cripito-sim');
  await v.create(PIN, {}); await v.lock();
  await v.unlock(PIN); await v.flush();
  const now = Date.now();
  assert.equal(v.backupStatus(now + 30 * DAY).due, false, 'sem mudança, não lembra');
  v.setItem('carteira', '[]'); await v.flush();
  assert.equal(v.backupStatus(now + 10 * DAY).due, false, 'antes de 15 dias');
  assert.equal(v.backupStatus(now + 16 * DAY).due, true, 'depois de 15 dias');
  await v.snoozeBackup(3, now + 16 * DAY);
  assert.equal(v.backupStatus(now + 17 * DAY).due, false, 'adiado');
  assert.equal(v.backupStatus(now + 20 * DAY).due, true, 'adiamento venceu');
  await v.markBackup(now + 20 * DAY);
  const st = v.backupStatus(now + 40 * DAY);
  assert.equal(st.due, false); assert.equal(st.changed, false); assert.equal(st.ageDays, 20);
  await v.setBackupDays(0); v.setItem('carteira', '[1]'); await v.flush();
  assert.equal(v.backupStatus(now + 400 * DAY).due, false, 'lembrete desligado');
  await assert.rejects(v.setBackupDays(9), /Prazo inválido/);
  // preferências cifradas e lidas de volta ao reabrir
  await v.lock(); await v.unlock(PIN);
  assert.equal(v.settings.backupDays, 0); assert.equal(v.settings.changed, true);
});

test('cópia deste app: abre aqui sem senha, em outro aparelho com as 12 palavras, e restaura', async () => {
  const storage = new MemoryStorage();
  const v = new Vault(storage, 'gerenc-fin');
  const seed = await v.create(PIN, { livro: '[10]' });
  const payload = await v.exportCopy();
  assert.doesNotMatch(JSON.stringify(payload), /livro/);
  v.setItem('livro', '[99]'); await v.flush();
  const copy = await v.openCopy(payload);
  assert.equal(copy.values.livro, '[10]');
  await v.restoreValues(copy.values);
  assert.equal(v.getItem('livro'), '[10]');
  // outro aparelho, outras palavras
  const other = new Vault(new MemoryStorage(), 'gerenc-fin');
  await other.create('193746', {});
  await assert.rejects(other.openCopy(payload), e => e.code === 'SEED_REQUIRED');
  const viaWords = await other.openCopy(payload, seed.words.join(' '));
  assert.equal(viaWords.values.livro, '[10]');
  // cópia de outro app é recusada
  const cambio = new Vault(storage, 'cambio-sim');
  await cambio.create(PIN, {});
  await assert.rejects(cambio.openCopy(payload), /outro app/);
});

test('mudar de celular: cópia de todos os apps restaura em aparelho novo, criando os cofres que faltam', async () => {
  const storage = new MemoryStorage(), store = new MapStore();
  const a = new Vault(storage, 'cambio-sim', () => {}, { dataStore: store });
  const seed = await a.create(PIN, { cambio_log: '["c"]' }); await a.lock();
  const b = new Vault(storage, 'gerenc-fin', () => {}, { dataStore: store });
  await b.create(PIN, { livro: '[7]' }); await b.lock();
  const legacyOwn = new Vault(storage, 'taxometro'); // app com PIN próprio (não ligado): fica de fora
  storage.setItem('financ-vault-v1:taxometro', JSON.stringify({ version: 1, appId: 'taxometro', password: {}, recovery: {} }));
  await a.unlock(PIN);
  const out = await a.exportAll();
  assert.deepEqual(out.apps.sort(), ['cambio-sim', 'gerenc-fin']);
  assert.deepEqual(out.skipped, ['taxometro']);
  // aparelho novo: só o Câmbio instalado; PIN e palavras novos
  const s2 = new MemoryStorage(), st2 = new MapStore();
  const n = new Vault(s2, 'cambio-sim', () => {}, { dataStore: st2 });
  await n.create('917364', {});
  const copy = await n.openCopy(out.payload, seed.words.join(' '));
  const done = await n.restoreAll(copy);
  assert.deepEqual(done.sort(), ['cambio-sim', 'gerenc-fin']);
  assert.equal(n.getItem('cambio_log'), '["c"]');
  await n.lock();
  const g = new Vault(s2, 'gerenc-fin', () => {}, { dataStore: st2 });
  await g.unlock('917364');
  assert.equal(g.getItem('livro'), '[7]');
});

test('contador de PIN: espera crescente, grava entre recarregamentos e bloqueia na 10ª falha', () => {
  const storage = new MemoryStorage();
  let now = 1_000_000;
  const guard = new PinGuard(storage, () => now);
  for (let i = 1; i <= 3; i++) assert.equal(guard.fail().waitMs, 0, 'três primeiras sem espera');
  assert.equal(guard.fail().waitMs, 30000);
  // "recarregar a página": outro objeto lendo o mesmo armazenamento
  const again = new PinGuard(storage, () => now);
  assert.equal(again.state().fails, 4); assert.equal(again.state().waitMs, 30000);
  for (let i = 5; i <= 9; i++) again.fail();
  assert.equal(again.state().waitMs, 14400000, 'nona falha: 4 h');
  const last = again.fail();
  assert.equal(last.locked, true); assert.equal(last.left, 0);
  again.reset();
  assert.deepEqual(new PinGuard(storage, () => now).state(), { fails: 0, waitMs: 0, locked: false, left: 10 });
  storage.setItem('financ-pin-guard-v1', '{lixo');
  assert.equal(new PinGuard(storage, () => now).state().fails, 0, 'registro ilegível vale como zero');
});

test('apagar o app apaga também os dados no IndexedDB', async () => {
  const storage = new MemoryStorage(), store = new MapStore();
  const v = new Vault(storage, 'invest-sim', () => {}, { dataStore: store });
  await v.create(PIN, { s: '1' });
  await v.destroy(PIN);
  assert.equal(await store.get('invest-sim'), undefined);
  assert.equal(storage.getItem('financ-vault-v1:invest-sim'), null);
});

test('abrir com gravação pendente não quebra a limpeza do legado; ela roda depois do flush', async () => {
  const storage = new MemoryStorage(), store = new MapStore();
  const old = new Vault(storage, 'gerenc-fin');
  await old.create(PIN, { livro_caixa_x: 'igual' }); await old.lock();
  storage.setItem('livro_caixa_x', 'igual'); // chave solta antiga, igual ao cofre
  const v = new Vault(storage, 'gerenc-fin', () => {}, { dataStore: store });
  await v.unlock(PIN);
  const matches = k => /^livro_caixa_/.test(k);
  assert.equal(v.cleanupLegacy(matches), false, 'com migração pendente, só adia');
  assert.equal(storage.getItem('livro_caixa_x'), 'igual');
  await v.flush();
  assert.equal(v.cleanupLegacy(matches), true);
  assert.equal(storage.getItem('livro_caixa_x'), null);
  assert.equal(v.cleanupLegacy(() => false), true, 'sem legado: nada a fazer');
});

test('apps com dados fora do cofre (BarGestão, Governança) ficam fora das cópias e sem lembrete', async () => {
  const storage = new MemoryStorage();
  const bar = new Vault(storage, 'multi-cm');
  await bar.create(PIN, { 'bg-login-salvo-v1': '{"chave":"x"}' });
  bar.setItem('bg-login-salvo-v1', '{"chave":"y"}'); await bar.flush();
  assert.equal(bar.backupStatus(Date.now() + 400 * DAY).due, false);
  await assert.rejects(bar.exportCopy(), /backup próprio/);
  await bar.lock();
  const lc = new Vault(storage, 'gerenc-fin');
  await lc.create(PIN, { livro: '[1]' });
  const out = await lc.exportAll();
  assert.deepEqual(out.apps, ['gerenc-fin'], 'BarGestão não entra na cópia de todos os apps');
});
