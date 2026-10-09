const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
// Roda tanto em stk-pkg-security/test quanto em <app>/test (o kit fica em <app>/src).
const find = name => [path.join(__dirname, '..', name), path.join(__dirname, '..', 'src', name)].find(p => fs.existsSync(p));
const { Vault } = require(find('stk-pkg-secure-vault.js'));
const A = require(find('stk-pkg-autosave.js'));

class MemoryStorage {
  constructor() { this.data = new Map(); }
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}
// Pasta simulada com a mesma interface da File System Access API (FileSystemDirectoryHandle).
const domError = name => Object.assign(new Error(name), { name });
class FakeDir {
  constructor(name = 'MeusApps') { this.name = name; this.files = new Map(); this.writes = []; this.failNext = null; this.slow = 0; }
  async getFileHandle(file, { create = false } = {}) {
    if (!this.files.has(file) && !create) throw domError('NotFoundError');
    const dir = this;
    return {
      kind: 'file',
      async getFile() { const text = dir.files.get(file) ?? ''; return { size: Buffer.byteLength(text), text: async () => text }; },
      async createWritable() {
        if (dir.failNext) { const n = dir.failNext; dir.failNext = null; throw domError(n); }
        let buf = '';
        return { write: async t => { buf += t; }, close: async () => { if (dir.slow) await new Promise(r => setTimeout(r, dir.slow)); dir.files.set(file, buf); dir.writes.push(file); }, abort: async () => {} };
      },
    };
  }
  async *entries() { for (const name of this.files.keys()) yield [name, await this.getFileHandle(name)]; }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function setup(appId = 'gerenc-fin', values = { livro_caixa_lancamentos: '[]' }) {
  const storage = new MemoryStorage();
  const vault = new Vault(storage, appId);
  await vault.create('123456', values);
  return { storage, vault };
}
function saverFor(storage, appId, extra = {}) {
  const states = [];
  const saver = new A.AutoSave({ storage, appId, delay: 20, onStatus: s => states.push(s.status), ...extra });
  return { saver, states };
}

test('primeira conexão grava o arquivo com o cofre cifrado e o FINANC ID (com uid)', async () => {
  const { storage } = await setup();
  const dir = new FakeDir();
  const { saver } = saverFor(storage, 'gerenc-fin');
  await saver.connect(dir);
  assert.equal(saver.status, 'saved');
  const file = await A.parse(dir.files.get('gerenc-fin.financ.json'), 'gerenc-fin');
  assert.equal(file.vault, storage.getItem('financ-vault-v1:gerenc-fin'));
  assert.equal(file.identity, storage.getItem('financ-id-v1'));
  assert.match(JSON.parse(file.identity).uid, /^[A-Za-z0-9+/=]{20,}$/);
  // Nada em texto puro: o lançamento não aparece no arquivo.
  assert.ok(!dir.files.get('gerenc-fin.financ.json').includes('livro_caixa_lancamentos'));
});

test('alterações seguidas viram uma gravação só (espera curta) e nada é regravado sem mudança', async () => {
  const { storage, vault } = await setup();
  const dir = new FakeDir();
  const { saver } = saverFor(storage, 'gerenc-fin');
  vault.onStored = () => saver.schedule();
  await saver.connect(dir);
  dir.writes.length = 0;
  for (let i = 0; i < 5; i++) vault.setItem('livro_caixa_x', String(i));
  await vault.flush();
  assert.equal(saver.status, 'pending');
  await wait(60); await saver.flush();
  const mains = dir.writes.filter(w => w === 'gerenc-fin.financ.json').length;
  assert.equal(mains, 1);
  assert.equal(saver.status, 'saved');
  await saver.flush();
  assert.equal(dir.writes.filter(w => w === 'gerenc-fin.financ.json').length, 1, 'sem mudança, sem nova gravação');
});

test('gravações não se sobrepõem: mudança durante a gravação gera uma segunda gravação com o estado final', async () => {
  const { storage, vault } = await setup();
  const dir = new FakeDir(); dir.slow = 30;
  const { saver } = saverFor(storage, 'gerenc-fin');
  await saver.connect(dir);
  vault.setItem('livro_caixa_x', 'a'); await vault.flush();
  const first = saver.flush();
  vault.setItem('livro_caixa_x', 'b'); await vault.flush();
  const second = saver.flush();
  await Promise.all([first, second]);
  const file = await A.parse(dir.files.get('gerenc-fin.financ.json'));
  assert.equal(file.vault, storage.getItem('financ-vault-v1:gerenc-fin'));
});

test('a versão anterior do arquivo vai para o .bak na primeira gravação da sessão', async () => {
  const { storage, vault } = await setup();
  const dir = new FakeDir();
  await saverFor(storage, 'gerenc-fin').saver.connect(dir);
  const before = dir.files.get('gerenc-fin.financ.json');
  const { saver } = saverFor(storage, 'gerenc-fin'); // nova sessão (app reaberto)
  await saver.connect(dir);
  vault.setItem('livro_caixa_x', '1'); await vault.flush(); await saver.flush();
  assert.equal(dir.files.get('gerenc-fin.financ.bak.json'), before);
  vault.setItem('livro_caixa_x', '2'); await vault.flush(); await saver.flush();
  assert.equal(dir.files.get('gerenc-fin.financ.bak.json'), before, 'o .bak guarda o início da sessão');
});

test('arquivo mais novo e diferente na pasta não é sobrescrito sem perguntar', async () => {
  const { storage } = await setup();
  const dir = new FakeDir();
  const other = await setup(); // outro aparelho/instalação gravou na mesma pasta
  await saverFor(other.storage, 'gerenc-fin').saver.connect(dir);
  const theirs = dir.files.get('gerenc-fin.financ.json');
  const { saver } = saverFor(storage, 'gerenc-fin');
  await saver.connect(dir);
  assert.equal(saver.status, 'conflict');
  assert.equal(dir.files.get('gerenc-fin.financ.json'), theirs);
  saver.schedule(); await wait(40);
  assert.equal(dir.files.get('gerenc-fin.financ.json'), theirs, 'em conflito não grava');
  await saver.keepLocal();
  assert.equal(saver.status, 'saved');
  assert.equal(dir.files.get('gerenc-fin.financ.bak.json'), theirs, 'manter o aparelho guarda o arquivo antigo no .bak');
});

test('arquivo gravado por este aparelho e depois alterado aqui segue gravando sem conflito', async () => {
  const { storage, vault } = await setup();
  const dir = new FakeDir();
  await saverFor(storage, 'gerenc-fin').saver.connect(dir);
  vault.setItem('livro_caixa_x', 'novo'); await vault.flush(); // mudou com a pasta desconectada
  const { saver } = saverFor(storage, 'gerenc-fin');
  await saver.connect(dir);
  assert.equal(saver.status, 'saved');
  assert.equal((await A.parse(dir.files.get('gerenc-fin.financ.json'))).vault, storage.getItem('financ-vault-v1:gerenc-fin'));
});

test('erros de gravação viram estado visível: sem permissão pede reconexão, sem espaço mostra erro', async () => {
  const { storage, vault } = await setup();
  const dir = new FakeDir();
  const { saver } = saverFor(storage, 'gerenc-fin');
  await saver.connect(dir);
  dir.failNext = 'NotAllowedError';
  vault.setItem('livro_caixa_x', '1'); await vault.flush(); await saver.flush();
  assert.equal(saver.status, 'reconnect');
  await saver.connect(dir);
  assert.equal(saver.status, 'saved');
  dir.failNext = 'QuotaExceededError';
  vault.setItem('livro_caixa_x', '2'); await vault.flush(); await saver.flush();
  assert.equal(saver.status, 'error');
  assert.match(saver.error, /espaço/);
});

test('falha passageira é tentada de novo sozinha', async () => {
  const { storage, vault } = await setup();
  const dir = new FakeDir();
  const { saver } = saverFor(storage, 'gerenc-fin');
  await saver.connect(dir);
  dir.failNext = 'NoModificationAllowedError';
  vault.setItem('livro_caixa_x', '1'); await vault.flush(); await saver.flush();
  assert.equal(saver.status, 'error');
  await wait(150);
  assert.equal(saver.status, 'saved');
});

test('arquivo adulterado é recusado na verificação de integridade', async () => {
  const { storage } = await setup();
  const snap = await A.snapshot(storage, 'gerenc-fin');
  const bad = JSON.parse(A.serialize(snap)); bad.vault = bad.vault.replace('"version":1', '"version":1 ');
  await assert.rejects(A.parse(JSON.stringify(bad)), /integridade/);
  await assert.rejects(A.parse('{"format":"x"}'), /não é um salvamento/);
  await assert.rejects(A.parse(A.serialize(snap), 'taxometro'), /outro app/);
});

test('navegador limpo: restaura FINANC ID e cofres de todos os apps da pasta e abre com o mesmo PIN', async () => {
  const storage = new MemoryStorage();
  const a = new Vault(storage, 'gerenc-fin'); await a.create('123456', { livro_caixa_lancamentos: '[1,2,3]' });
  const b = new Vault(storage, 'taxometro'); await b.create('123456', { tax: '42' });
  const dir = new FakeDir();
  await saverFor(storage, 'gerenc-fin').saver.connect(dir);
  await saverFor(storage, 'taxometro').saver.connect(dir);
  await a.lock(); await b.lock();

  const clean = new MemoryStorage(); // "Limpar dados do Chrome"
  const plan = A.planRestore(clean, await A.readMirrors(dir));
  assert.deepEqual(A.applyRestore(clean, plan).sort(), ['gerenc-fin', 'taxometro']);
  const back = new Vault(clean, 'gerenc-fin');
  await back.unlock('123456');
  assert.equal(back.getItem('livro_caixa_lancamentos'), '[1,2,3]');
  const tax = new Vault(clean, 'taxometro');
  await tax.unlock('123456');
  assert.equal(tax.getItem('tax'), '42');
  // Depois de restaurar, a pasta é reconhecida como "nossa": sem conflito.
  const { saver } = saverFor(clean, 'gerenc-fin');
  await saver.connect(dir);
  assert.equal(saver.status, 'saved');
});

test('restaurar nunca sobrescreve cofre existente nem mistura PIN de outra instalação', async () => {
  const old = await setup('gerenc-fin', { livro_caixa_x: 'antigo' });
  const dir = new FakeDir();
  await saverFor(old.storage, 'gerenc-fin').saver.connect(dir);
  // Aparelho com outro FINANC ID (PIN criado de novo) e cofre do taxômetro já existente.
  const now = await setup('taxometro', { tax: '1' });
  const plan = A.planRestore(now.storage, await A.readMirrors(dir));
  assert.equal(plan.identity, null);
  assert.deepEqual(plan.vaults, []);
  assert.deepEqual(plan.skipped, [{ appId: 'gerenc-fin', reason: 'other-identity' }]);
  // Mesmo FINANC ID e cofre já existente: fica como está.
  const same = A.planRestore(old.storage, await A.readMirrors(dir));
  assert.deepEqual(same.skipped, [{ appId: 'gerenc-fin', reason: 'exists' }]);
});

test('principal estragado: usa o .bak; arquivos estranhos na pasta são ignorados', async () => {
  const { storage } = await setup();
  const dir = new FakeDir();
  const snap = await A.snapshot(storage, 'gerenc-fin');
  dir.files.set('gerenc-fin.financ.json', '{quebrado');
  dir.files.set('gerenc-fin.financ.bak.json', A.serialize(snap));
  dir.files.set('foto.jpg', 'xx'); dir.files.set('../x.financ.json', A.serialize(snap));
  const mirrors = await A.readMirrors(dir);
  assert.equal(mirrors.length, 1);
  assert.equal(mirrors[0].digest, snap.digest);
});

test('FINANC ID ganha uid fixo e o aviso de gravação dispara nas mudanças', async () => {
  const { storage, vault } = await setup();
  let stored = 0, identity = 0;
  vault.onStored = () => { stored += 1; }; vault.identity.onWrite = () => { identity += 1; };
  const uid = JSON.parse(storage.getItem('financ-id-v1')).uid;
  vault.setItem('livro_caixa_x', '1'); await vault.flush();
  await vault.changePin('123456', '654321');
  assert.ok(stored >= 1); assert.ok(identity >= 1);
  assert.equal(JSON.parse(storage.getItem('financ-id-v1')).uid, uid, 'trocar o PIN não muda o uid');
});
