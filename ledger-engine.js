/**
 * ledger-engine.js - Motor de cálculo do Livro-Caixa
 * Refatorado para Arquitetura Hexagonal, Orientação a Objetos e Criptografia.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LedgerEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ==========================================
  // INFRASTRUCTURE LAYER
  // ==========================================
  class CryptoAdapter {
    static async encryptData(plainText, key) {
      const cryptoObj = typeof crypto !== 'undefined' ? crypto : (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
      if (!cryptoObj || !cryptoObj.subtle) throw new Error('Web Cryptography API não suportada');
      const iv = cryptoObj.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(plainText);
      const ciphertext = await cryptoObj.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, encoded);
      return { iv: Array.from(iv), cipher: Array.from(new Uint8Array(ciphertext)) };
    }

    static async decryptData(encryptedObj, key) {
      const cryptoObj = typeof crypto !== 'undefined' ? crypto : (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
      if (!cryptoObj || !cryptoObj.subtle) throw new Error('Web Cryptography API não suportada');
      const iv = new Uint8Array(encryptedObj.iv);
      const cipher = new Uint8Array(encryptedObj.cipher);
      const decrypted = await cryptoObj.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, cipher);
      return new TextDecoder().decode(decrypted);
    }
  }

  // ==========================================
  // DOMAIN LAYER (Value Objects & Helpers)
  // ==========================================
  class LedgerConstants {
    constructor() {
      this._schemaVersion = 2;
      this._maxCents = 99999999999;
      this._categoriasPadrao = ['Moradia', 'Alimentação', 'Transporte', 'Saúde', 'Educação', 'Lazer', 'Cartão', 'Dívidas', 'Salário', 'Outros'];
      this._horizonteDias = 90;
    }
    get schemaVersion() { return this._schemaVersion; }
    get maxCents() { return this._maxCents; }
    get categoriasPadrao() { return this._categoriasPadrao; }
    get horizonteDias() { return this._horizonteDias; }
  }

  class DateHelper {
    static pad(n) { return (n < 10 ? '0' : '') + n; }
    static localISO(date) { return date.getFullYear() + '-' + this.pad(date.getMonth() + 1) + '-' + this.pad(date.getDate()); }
    static hojeISO(now) { return this.localISO(now instanceof Date ? now : new Date()); }
    static parseISO(iso) { const p = String(iso).split('-'); return { y: +p[0], m: +p[1], d: +p[2] }; }
    static lastDayOfMonth(y, m) { return new Date(y, m, 0).getDate(); }
    static isValidISO(text) {
      if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
      const p = this.parseISO(text);
      return p.m >= 1 && p.m <= 12 && p.d >= 1 && p.d <= this.lastDayOfMonth(p.y, p.m);
    }
    static makeISO(y, m, d) { return String(y).padStart(4, '0') + '-' + this.pad(m) + '-' + this.pad(d); }
    static addDays(iso, n) { const p = this.parseISO(iso); return this.localISO(new Date(p.y, p.m - 1, p.d + n)); }
    static addMonths(iso, n, dia) {
      const p = this.parseISO(iso); const want = dia || p.d;
      const total = p.y * 12 + (p.m - 1) + n; const y = Math.floor(total / 12); const m = (total % 12 + 12) % 12 + 1;
      return this.makeISO(y, m, Math.min(want, this.lastDayOfMonth(y, m)));
    }
    static monthKey(iso) { return iso ? String(iso).slice(0, 7) : ''; }
    static monthStart(mk) { return mk + '-01'; }
    static monthEnd(mk) { const p = mk.split('-'); return this.makeISO(+p[0], +p[1], this.lastDayOfMonth(+p[0], +p[1])); }
    static addMonthKey(mk, n) { return this.monthKey(this.addMonths(mk + '-01', n, 1)); }
    static dateBR(iso) { if (!iso) return ''; const p = String(iso).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  }

  class MathHelper {
    static _constants = new LedgerConstants();

    static parseCents(value) {
      let s;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        s = String(value);
        if (/e/i.test(s)) return Math.round(value * 100);
      } else if (typeof value === 'string') {
        s = value.trim().replace(/^R\$\s*/i, '').replace(/\s+/g, '');
      } else return null;
      let neg = false;
      if (s[0] === '-') { neg = true; s = s.slice(1); } else if (s[0] === '+') s = s.slice(1);
      if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
      const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
      let intPart, frac = '';
      if (lastComma >= 0 && lastDot >= 0) {
        const decPos = Math.max(lastComma, lastDot);
        intPart = s.slice(0, decPos).replace(/[.,]/g, ''); frac = s.slice(decPos + 1);
      } else if (lastComma >= 0) {
        if (s.indexOf(',') !== lastComma) return null;
        intPart = s.slice(0, lastComma); frac = s.slice(lastComma + 1);
      } else if (lastDot >= 0) {
        if (s.indexOf('.') !== lastDot) { intPart = s.replace(/\./g, ''); }
        else { intPart = s.slice(0, lastDot); frac = s.slice(lastDot + 1); }
      } else intPart = s;
      if (!/^\d*$/.test(intPart) || !/^\d*$/.test(frac)) return null;
      let cents = (parseInt(intPart || '0', 10) * 100) + parseInt((frac + '00').slice(0, 2), 10);
      if (frac.length > 2 && frac.charCodeAt(2) >= 53) cents += 1;
      return neg ? -cents : cents;
    }

    static safeCents(value, emCentavos) {
      let n = emCentavos ? Number(value) : this.parseCents(typeof value === 'number' || typeof value === 'string' ? value : null);
      if (emCentavos) n = Number.isFinite(n) ? Math.round(n) : NaN;
      return Number.isFinite(n) && n >= 0 && n <= this._constants.maxCents ? n : 0;
    }

    static fmtBRL(cents) {
      return ((Number(cents) || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    static centsToInput(cents) {
      let c = Math.round(Number(cents) || 0); const neg = c < 0; if (neg) c = -c;
      return (neg ? '-' : '') + Math.floor(c / 100) + '.' + DateHelper.pad(c % 100);
    }

    static sum(list, fn) { let t = 0; for (let i = 0; i < list.length; i++) t += fn(list[i]); return t; }
    static uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
    static safeId(value, vazioOk) { const id = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80); return id || (vazioOk ? '' : this.uid()); }
    static safeText(value) { return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200); }
    static safeDate(value) { return DateHelper.isValidISO(String(value || '')) ? String(value) : ''; }
    static safeInt(value, min, max, def) { const n = Math.trunc(Number(value)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; }
  }

  // ==========================================
  // DOMAIN LAYER (State & Normalization)
  // ==========================================
  class LedgerStateBuilder {
    static _constants = new LedgerConstants();

    static freshState() {
      return {
        schemaVersion: this._constants.schemaVersion,
        categorias: this._constants.categoriasPadrao.slice(),
        orcamentos: {}, recorrencias: [], expenses: [], income: [],
        card: { limite: 0, fechamento: 1, vencimentoDia: 11, lancamentos: [], faturas: [] },
        debts: []
      };
    }

    static defaultVencimentoDia(fechamento) { const d = fechamento + 10; return d > 31 ? d - 30 : d; }

    static normalizeState(parsed) {
      const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      const card = source.card && typeof source.card === 'object' ? source.card : {};
      const emCentavos = Number(source.schemaVersion) >= 2;
      const money = (v) => MathHelper.safeCents(v, emCentavos);
      const list = (v) => Array.isArray(v) ? v.slice(0, 10000).filter(x => x && typeof x === 'object') : [];
      const out = this.freshState();
      
      const cats = {};
      this._constants.categoriasPadrao.forEach(c => { cats[c] = true; });
      (Array.isArray(source.categorias) ? source.categorias : []).slice(0, 100).forEach(c => { c = MathHelper.safeText(c).slice(0, 40); if (c) cats[c] = true; });
      const addCat = (c) => { c = MathHelper.safeText(c).slice(0, 40); if (c) cats[c] = true; return c; };
      const cat = (v, def) => addCat(v) || def || 'Outros';

      out.expenses = list(source.expenses).map(x => {
        const valor = money(x.valor), pago = x.pago === true, venc = MathHelper.safeDate(x.vencimento);
        const dataPag = MathHelper.safeDate(x.dataPagamento) || (pago ? venc : '');
        const o = x.origem && typeof x.origem === 'object' ? x.origem : null;
        const tipoOrigem = o && (o.tipo === 'fatura' || o.tipo === 'divida') ? o.tipo : '';
        return {
          id: MathHelper.safeId(x.id), valor, descricao: MathHelper.safeText(x.descricao), vencimento: venc, pago,
          dataPagamento: pago ? dataPag : null,
          valorPago: pago ? (x.valorPago == null ? valor : money(x.valorPago)) : null,
          categoria: cat(x.categoria), natureza: x.natureza === 'fixa' ? 'fixa' : 'variavel',
          origem: tipoOrigem ? { tipo: tipoOrigem, id: MathHelper.safeId(o.id, true), parcela: MathHelper.safeInt(o.parcela, 0, 1200, 0) } : null,
          recorrenciaId: MathHelper.safeId(x.recorrenciaId, true), competencia: /^\d{4}-\d{2}$/.test(String(x.competencia || '')) ? String(x.competencia) : ''
        };
      }).filter(x => x.descricao && x.vencimento);

      out.income = list(source.income).map(x => ({
        id: MathHelper.safeId(x.id), valor: money(x.valor), descricao: MathHelper.safeText(x.descricao), data: MathHelper.safeDate(x.data),
        categoria: cat(x.categoria, 'Outros'),
        recorrenciaId: MathHelper.safeId(x.recorrenciaId, true), competencia: /^\d{4}-\d{2}$/.test(String(x.competencia || '')) ? String(x.competencia) : ''
      })).filter(x => x.descricao && x.data);

      out.card.limite = money(card.limite);
      out.card.fechamento = MathHelper.safeInt(card.fechamento, 1, 31, 1);
      out.card.vencimentoDia = MathHelper.safeInt(card.vencimentoDia, 1, 31, this.defaultVencimentoDia(out.card.fechamento));
      
      const normLanc = (x) => {
        const parcelas = MathHelper.safeInt(x.parcelas, 1, 120, 1);
        return {
          id: MathHelper.safeId(x.id), valor: money(x.valor), descricao: MathHelper.safeText(x.descricao), data: MathHelper.safeDate(x.data),
          categoria: cat(x.categoria), tipo: x.tipo === 'credito' ? 'credito' : 'compra',
          parcelas, parcelaAtual: MathHelper.safeInt(x.parcelaAtual, 1, parcelas, 1),
          compraId: MathHelper.safeId(x.compraId, true), transporteDe: MathHelper.safeId(x.transporteDe, true)
        };
      };
      out.card.lancamentos = list(card.lancamentos).map(normLanc).filter(x => x.descricao && x.data);
      
      out.card.faturas = list(card.faturas).map(x => ({
        id: MathHelper.safeId(x.id), total: money(x.total), dataFechamento: MathHelper.safeDate(x.dataFechamento),
        vencimento: MathHelper.safeDate(x.vencimento), despesaId: MathHelper.safeId(x.despesaId, true),
        itens: list(x.itens).map(normLanc).filter(i => i.descricao && i.data)
      })).filter(x => x.dataFechamento);

      out.card.faturas.forEach(f => {
        const d = f.despesaId && out.expenses.find(e => e.id === f.despesaId);
        if (d) { if (!d.origem) d.origem = { tipo: 'fatura', id: f.id, parcela: 0 }; if (!f.vencimento) f.vencimento = d.vencimento; }
      });

      out.debts = list(source.debts).map(x => {
        const parcelas = MathHelper.safeInt(x.parcelas, 1, 1200, 1), venc = MathHelper.safeDate(x.vencimento), taxa = Number(x.taxa);
        return {
          id: MathHelper.safeId(x.id), valorParcela: money(x.valorParcela), descricao: MathHelper.safeText(x.descricao), parcelas,
          parcelaAtual: MathHelper.safeInt(x.parcelaAtual, 1, parcelas, 1), vencimento: venc,
          diaOriginal: MathHelper.safeInt(x.diaOriginal, 1, 31, venc ? DateHelper.parseISO(venc).d : 1),
          pago: x.pago === true,
          pagas: list(x.pagas).map(p => ({ parcela: MathHelper.safeInt(p.parcela, 1, 1200, 1), vencimento: MathHelper.safeDate(p.vencimento), despesaId: MathHelper.safeId(p.despesaId, true) })),
          valorContratado: x.valorContratado == null ? null : money(x.valorContratado),
          taxa: Number.isFinite(taxa) && taxa >= 0 && taxa <= 1000 ? taxa : null,
          categoria: cat(x.categoria, 'Dívidas')
        };
      }).filter(x => x.descricao && x.vencimento);

      out.recorrencias = list(source.recorrencias).map(x => ({
        id: MathHelper.safeId(x.id), tipo: x.tipo === 'entrada' ? 'entrada' : 'despesa', valor: money(x.valor), descricao: MathHelper.safeText(x.descricao),
        dia: MathHelper.safeInt(x.dia, 1, 31, 1), inicio: MathHelper.safeDate(x.inicio), fim: MathHelper.safeDate(x.fim) || '', categoria: cat(x.categoria),
        natureza: x.natureza === 'variavel' ? 'variavel' : 'fixa', ativa: x.ativa !== false,
        ignoradas: (Array.isArray(x.ignoradas) ? x.ignoradas : []).filter(m => /^\d{4}-\d{2}$/.test(String(m))).slice(0, 600)
      })).filter(x => x.descricao && x.inicio && x.valor > 0);

      const orc = source.orcamentos && typeof source.orcamentos === 'object' && !Array.isArray(source.orcamentos) ? source.orcamentos : {};
      Object.keys(orc).slice(0, 100).forEach(k => { const c = addCat(k); const v = money(orc[k]); if (c && v > 0) out.orcamentos[c] = v; });

      out.categorias = Object.keys(cats);
      return out;
    }
  }

  // ==========================================
  // APPLICATION LAYER (Use Cases / Services)
  // ==========================================
  class ExpenseService {
    static _constants = new LedgerConstants();

    static makeExpense(o) {
      return { id: o.id || MathHelper.uid(), valor: o.valor, descricao: o.descricao, vencimento: o.vencimento, pago: false, dataPagamento: null, valorPago: null, categoria: o.categoria || 'Outros', natureza: o.natureza === 'fixa' ? 'fixa' : 'variavel', origem: o.origem || null, recorrenciaId: o.recorrenciaId || '', competencia: o.competencia || '' };
    }
    static makeIncome(o) {
      return { id: o.id || MathHelper.uid(), valor: o.valor, descricao: o.descricao, data: o.data, categoria: o.categoria || 'Outros', recorrenciaId: o.recorrenciaId || '', competencia: o.competencia || '' };
    }
    static findExpense(state, id) { return state.expenses.find(e => e.id === id); }
    static expenseAjuste(e) { return e.pago && e.valorPago !== null ? e.valorPago - e.valor : 0; }

    static payExpense(state, id, opts, hoje) {
      const e = this.findExpense(state, id); const o = opts || {};
      if (!e) return { ok: false, erro: 'Despesa não encontrada.' };
      if (e.pago) return { ok: false, erro: 'Esta despesa já está paga.' };
      const data = o.data || hoje;
      if (!DateHelper.isValidISO(data)) return { ok: false, erro: 'Informe uma data de pagamento válida.' };
      if (hoje && data > hoje) return { ok: false, erro: 'A data do pagamento não pode ser futura.' };
      const valorPago = o.valorPago === undefined || o.valorPago === null ? e.valor : o.valorPago;
      if (!Number.isInteger(valorPago) || valorPago <= 0 || valorPago > this._constants.maxCents) return { ok: false, erro: 'Informe um valor pago válido.' };
      e.pago = true; e.dataPagamento = data; e.valorPago = valorPago;
      return { ok: true, ajuste: valorPago - e.valor };
    }

    static unpayExpense(state, id) {
      const e = this.findExpense(state, id);
      if (!e) return { ok: false, erro: 'Despesa não encontrada.' };
      if (!e.pago) return { ok: false, erro: 'Esta despesa não está paga.' };
      if (e.origem && e.origem.tipo === 'divida') return DebtService.undoDebtPayment(state, e.origem.id, e.id);
      e.pago = false; e.dataPagamento = null; e.valorPago = null;
      return { ok: true };
    }

    static canDeleteExpense(state, id) {
      const e = this.findExpense(state, id);
      if (!e) return { ok: false, motivo: 'Despesa não encontrada.' };
      if (e.origem && e.origem.tipo === 'fatura') return { ok: false, vinculo: 'fatura', motivo: 'Esta despesa é a fatura do cartão. Para removê-la, reabra a fatura na aba Cartão (estorne o pagamento antes, se já estiver paga).' };
      if (e.origem && e.origem.tipo === 'divida') return { ok: false, vinculo: 'divida', motivo: 'Esta despesa é o pagamento de uma parcela de dívida. Para desfazer, estorne o pagamento (a parcela volta para a aba Dívidas).' };
      return { ok: true };
    }

    static deleteExpense(state, id) {
      const chk = this.canDeleteExpense(state, id);
      if (!chk.ok) return chk;
      const e = this.findExpense(state, id);
      if (e.recorrenciaId && e.competencia) {
        const r = state.recorrencias.find(x => x.id === e.recorrenciaId);
        if (r && r.ignoradas.indexOf(e.competencia) < 0) r.ignoradas.push(e.competencia);
      }
      state.expenses = state.expenses.filter(x => x.id !== id);
      return { ok: true };
    }
  }

  class DebtService {
    static _constants = new LedgerConstants();

    static findDebt(state, id) { return state.debts.find(d => d.id === id); }
    static debtRemainingCount(d) { return d.pago ? 0 : d.parcelas - d.parcelaAtual + 1; }
    static debtSaldo(d) { return this.debtRemainingCount(d) * d.valorParcela; }
    static debtSaldoTotal(state) { return MathHelper.sum(state.debts, d => this.debtSaldo(d)); }
    
    static debtInstallments(d) {
      const out = [];
      for (let k = 0; k < this.debtRemainingCount(d); k++) {
        out.push({ parcela: d.parcelaAtual + k, vencimento: k === 0 ? d.vencimento : DateHelper.addMonths(d.vencimento, k, d.diaOriginal), valor: d.valorParcela });
      }
      return out;
    }

    static payDebtInstallment(state, debtId, opts, hoje) {
      const d = this.findDebt(state, debtId); const o = opts || {};
      if (!d) return { ok: false, erro: 'Dívida não encontrada.' };
      if (d.pago) return { ok: false, erro: 'Esta dívida já está quitada.' };
      const data = o.data || hoje;
      if (!DateHelper.isValidISO(data)) return { ok: false, erro: 'Informe uma data de pagamento válida.' };
      if (hoje && data > hoje) return { ok: false, erro: 'A data do pagamento não pode ser futura.' };
      const valorPago = o.valorPago === undefined || o.valorPago === null ? d.valorParcela : o.valorPago;
      if (!Number.isInteger(valorPago) || valorPago <= 0 || valorPago > this._constants.maxCents) return { ok: false, erro: 'Informe um valor pago válido.' };
      
      const parcela = d.parcelaAtual, venc = d.vencimento;
      const despesa = ExpenseService.makeExpense({ valor: d.valorParcela, descricao: d.descricao + ' (parcela ' + parcela + '/' + d.parcelas + ')', vencimento: venc, categoria: d.categoria, natureza: 'fixa', origem: { tipo: 'divida', id: d.id, parcela: parcela } });
      despesa.pago = true; despesa.dataPagamento = data; despesa.valorPago = valorPago;
      
      state.expenses.push(despesa);
      d.pagas.push({ parcela, vencimento: venc, despesaId: despesa.id });
      if (d.parcelaAtual >= d.parcelas) d.pago = true;
      else { d.parcelaAtual += 1; d.vencimento = DateHelper.addMonths(venc, 1, d.diaOriginal); }
      return { ok: true, despesa, quitada: d.pago };
    }

    static undoDebtPayment(state, debtId, despesaId) {
      const d = this.findDebt(state, debtId);
      if (!d) return { ok: false, erro: 'Dívida não encontrada.' };
      const ultima = d.pagas[d.pagas.length - 1];
      if (!ultima) return { ok: false, erro: 'Não há pagamento registrado para desfazer.' };
      if (despesaId && ultima.despesaId !== despesaId) return { ok: false, erro: 'Só é possível estornar a parcela mais recente. Estorne primeiro as parcelas seguintes.' };
      state.expenses = state.expenses.filter(e => e.id !== ultima.despesaId);
      d.pagas.pop();
      d.parcelaAtual = ultima.parcela; d.vencimento = ultima.vencimento; d.pago = false;
      return { ok: true, parcela: ultima.parcela };
    }
  }

  class CardService {
    static signedValor(l) { return l.tipo === 'credito' ? -l.valor : l.valor; }
    
    static closingDateFor(iso, fechamentoDia) {
      const p = DateHelper.parseISO(iso), fecha = Math.min(fechamentoDia, DateHelper.lastDayOfMonth(p.y, p.m));
      if (p.d <= fecha) return DateHelper.makeISO(p.y, p.m, fecha);
      return DateHelper.addMonths(DateHelper.makeISO(p.y, p.m, 1), 1, fechamentoDia);
    }
    
    static dueDateFor(closingISO, vencimentoDia) {
      const p = DateHelper.parseISO(closingISO), mesmo = DateHelper.addMonths(DateHelper.makeISO(p.y, p.m, 1), 0, vencimentoDia);
      return mesmo > closingISO ? mesmo : DateHelper.addMonths(DateHelper.makeISO(p.y, p.m, 1), 1, vencimentoDia);
    }

    static openCycles(state) {
      const map = {}, card = state.card;
      card.lancamentos.forEach(l => {
        const f = this.closingDateFor(l.data, card.fechamento);
        (map[f] = map[f] || { fechamento: f, vencimento: this.dueDateFor(f, card.vencimentoDia), itens: [], total: 0 });
        map[f].itens.push(l); map[f].total += this.signedValor(l);
      });
      return Object.keys(map).sort().map(k => map[k]);
    }

    static faturaDespesa(state, f) { return f.despesaId ? ExpenseService.findExpense(state, f.despesaId) : undefined; }
    static faturaEmAberto(state, f) { const d = this.faturaDespesa(state, f); return !!d && !d.pago; }
    static cardOpenTotal(state) { return MathHelper.sum(state.card.lancamentos, l => this.signedValor(l)); }
    static cardInvoicesUnpaid(state) { return MathHelper.sum(state.card.faturas.filter(f => this.faturaEmAberto(state, f)), f => f.total); }
    static cardUsed(state) { return Math.max(0, this.cardOpenTotal(state) + this.cardInvoicesUnpaid(state)); }
    static cardAvailable(state) { return Math.max(0, state.card.limite - this.cardUsed(state)); }

    static splitInstallments(total, n) {
      const base = Math.floor(total / n), resto = total - base * n, out = [];
      for (let i = 0; i < n; i++) out.push(base + (i === 0 ? resto : 0));
      return out;
    }

    static addCardPurchase(state, o) {
      const tipo = o.tipo === 'credito' ? 'credito' : 'compra';
      const n = tipo === 'credito' ? 1 : MathHelper.safeInt(o.parcelas, 1, 120, 1);
      const valores = this.splitInstallments(o.valor, n), dia = DateHelper.parseISO(o.data).d, compraId = n > 1 ? MathHelper.uid() : '', criadas = [];
      for (let i = 0; i < n; i++) {
        criadas.push({ id: MathHelper.uid(), valor: valores[i], descricao: o.descricao, data: i === 0 ? o.data : DateHelper.addMonths(o.data, i, dia), categoria: o.categoria || 'Outros', tipo, parcelas: n, parcelaAtual: i + 1, compraId, transporteDe: '' });
      }
      Array.prototype.push.apply(state.card.lancamentos, criadas);
      return criadas;
    }

    static closeInvoice(state, fechamentoISO, hoje) {
      const ciclos = this.openCycles(state), alvo = ciclos.find(c => c.fechamento === fechamentoISO);
      if (!alvo) return { ok: false, erro: 'Ciclo não encontrado.' };
      if (alvo.fechamento > hoje) return { ok: false, erro: 'Este ciclo só fecha em ' + DateHelper.dateBR(alvo.fechamento) + '.' };
      const incluidos = ciclos.filter(c => c.fechamento <= alvo.fechamento), itens = [];
      incluidos.forEach(c => { Array.prototype.push.apply(itens, c.itens); });
      const liquido = MathHelper.sum(itens, l => this.signedValor(l)), faturaId = MathHelper.uid(); let despesa = null;
      const fatura = { id: faturaId, total: Math.max(0, liquido), dataFechamento: alvo.fechamento, vencimento: alvo.vencimento, despesaId: '', itens };
      if (liquido > 0) {
        despesa = ExpenseService.makeExpense({ valor: liquido, descricao: 'Fatura do cartão (fechamento ' + DateHelper.dateBR(alvo.fechamento) + ')', vencimento: alvo.vencimento, categoria: 'Cartão', origem: { tipo: 'fatura', id: faturaId, parcela: 0 } });
        state.expenses.push(despesa); fatura.despesaId = despesa.id;
      }
      const ids = {}; itens.forEach(l => { ids[l.id] = true; });
      state.card.lancamentos = state.card.lancamentos.filter(l => !ids[l.id]);
      if (liquido < 0) {
        state.card.lancamentos.push({ id: MathHelper.uid(), valor: -liquido, descricao: 'Crédito da fatura de ' + DateHelper.dateBR(alvo.fechamento), data: DateHelper.addDays(alvo.fechamento, 1), categoria: 'Cartão', tipo: 'credito', parcelas: 1, parcelaAtual: 1, compraId: '', transporteDe: faturaId });
      }
      state.card.faturas.push(fatura);
      return { ok: true, fatura, despesa };
    }

    static deleteCardItem(state, id) {
      const l = state.card.lancamentos.find(x => x.id === id);
      if (!l) return { ok: false, erro: 'Lançamento não encontrado.' };
      const antes = state.card.lancamentos.length;
      state.card.lancamentos = state.card.lancamentos.filter(x => l.compraId ? x.compraId !== l.compraId : x.id !== id);
      return { ok: true, removidos: antes - state.card.lancamentos.length };
    }

    static reopenInvoice(state, faturaId) {
      const f = state.card.faturas.find(x => x.id === faturaId);
      if (!f) return { ok: false, erro: 'Fatura não encontrada.' };
      const d = this.faturaDespesa(state, f);
      if (d && d.pago) return { ok: false, erro: 'Esta fatura já foi paga. Estorne o pagamento em Despesas antes de reabri-la.' };
      state.card.lancamentos = state.card.lancamentos.filter(l => l.transporteDe !== f.id);
      Array.prototype.push.apply(state.card.lancamentos, f.itens);
      if (d) state.expenses = state.expenses.filter(e => e.id !== d.id);
      state.card.faturas = state.card.faturas.filter(x => x.id !== f.id);
      return { ok: true, devolvidos: f.itens.length };
    }
  }

  class RecurrenceService {
    static _constants = new LedgerConstants();

    static addRecurrence(state, o) {
      if (!DateHelper.isValidISO(o.inicio)) return { ok: false, erro: 'Informe a data da primeira ocorrência.' };
      if (!Number.isInteger(o.valor) || o.valor <= 0 || o.valor > this._constants.maxCents) return { ok: false, erro: 'Informe um valor válido.' };
      const descricao = MathHelper.safeText(o.descricao);
      if (!descricao) return { ok: false, erro: 'Informe a descrição.' };
      const r = {
        id: MathHelper.uid(), tipo: o.tipo === 'entrada' ? 'entrada' : 'despesa', valor: o.valor, descricao, dia: DateHelper.parseISO(o.inicio).d, inicio: o.inicio,
        fim: DateHelper.isValidISO(o.fim) ? o.fim : '', categoria: ReportService.addCategory(state, o.categoria) || 'Outros', natureza: o.natureza === 'variavel' ? 'variavel' : 'fixa',
        ativa: true, ignoradas: []
      };
      state.recorrencias.push(r);
      return { ok: true, recorrencia: r };
    }

    static materializeRecurrences(state, hoje) {
      const ate = DateHelper.monthKey(DateHelper.addDays(hoje, this._constants.horizonteDias)); let criadas = 0;
      state.recorrencias.forEach(r => {
        if (!r.ativa) return;
        const tem = {};
        (r.tipo === 'entrada' ? state.income : state.expenses).forEach(x => { if (x.recorrenciaId === r.id && x.competencia) tem[x.competencia] = true; });
        let mk = DateHelper.monthKey(r.inicio);
        for (let guard = 0; mk <= ate && guard < 1200; guard++, mk = DateHelper.addMonthKey(mk, 1)) {
          const data = DateHelper.addMonths(DateHelper.monthStart(mk), 0, r.dia);
          if (data < r.inicio || (r.fim && data > r.fim) || tem[mk] || r.ignoradas.indexOf(mk) >= 0) continue;
          if (r.tipo === 'entrada') state.income.push(ExpenseService.makeIncome({ valor: r.valor, descricao: r.descricao, data, categoria: r.categoria, recorrenciaId: r.id, competencia: mk }));
          else state.expenses.push(ExpenseService.makeExpense({ valor: r.valor, descricao: r.descricao, vencimento: data, categoria: r.categoria, natureza: r.natureza, recorrenciaId: r.id, competencia: mk }));
          criadas++;
        }
      });
      return criadas;
    }

    static setRecurrenceActive(state, id, ativa) {
      const r = state.recorrencias.find(x => x.id === id);
      if (r) r.ativa = !!ativa;
      return !!r;
    }

    static removeRecurrence(state, id, hoje) {
      state.recorrencias = state.recorrencias.filter(r => r.id !== id);
      state.expenses = state.expenses.filter(e => !(e.recorrenciaId === id && !e.pago && e.vencimento > hoje));
      state.income = state.income.filter(i => !(i.recorrenciaId === id && i.data > hoje));
      state.expenses.forEach(e => { if (e.recorrenciaId === id) { e.recorrenciaId = ''; e.competencia = ''; } });
      state.income.forEach(i => { if (i.recorrenciaId === id) { i.recorrenciaId = ''; i.competencia = ''; } });
    }
  }

  class ReportService {
    static _constants = new LedgerConstants();

    static addCategory(state, nome) {
      const c = MathHelper.safeText(nome).slice(0, 40);
      if (!c) return '';
      if (state.categorias.indexOf(c) < 0) state.categorias.push(c);
      return c;
    }

    static monthReport(state, mk) {
      let receitas = 0, fixas = 0, variaveis = 0, dividas = 0; const porCat = {}, recPorCat = {};
      const soma = (mapa, cat, v) => { mapa[cat] = (mapa[cat] || 0) + v; };
      state.income.forEach(i => { if (DateHelper.monthKey(i.data) === mk) { receitas += i.valor; soma(recPorCat, i.categoria, i.valor); } });
      state.expenses.forEach(e => {
        if (DateHelper.monthKey(e.vencimento) !== mk) return;
        const o = e.origem && e.origem.tipo;
        if (o === 'divida') { dividas += e.valor; soma(porCat, e.categoria, e.valor); }
        else if (o === 'fatura') return;
        else { if (e.natureza === 'fixa') fixas += e.valor; else variaveis += e.valor; soma(porCat, e.categoria, e.valor); }
      });
      state.debts.forEach(d => {
        DebtService.debtInstallments(d).forEach(p => { if (DateHelper.monthKey(p.vencimento) === mk) { dividas += p.valor; soma(porCat, d.categoria, p.valor); } });
      });
      const itens = state.card.lancamentos.slice();
      state.card.faturas.forEach(f => {
        if (f.itens.length) Array.prototype.push.apply(itens, f.itens);
        else { const d = CardService.faturaDespesa(state, f); if (d && DateHelper.monthKey(d.vencimento) === mk) { variaveis += d.valor; soma(porCat, 'Cartão', d.valor); } }
      });
      itens.forEach(l => {
        if (l.transporteDe || DateHelper.monthKey(l.data) !== mk) return;
        const v = CardService.signedValor(l); variaveis += v; soma(porCat, l.categoria, v);
      });
      const totalDespesas = fixas + variaveis + dividas;
      return { mes: mk, receitas, fixas, variaveis, dividas, totalDespesas, resultado: receitas - totalDespesas, despesasPorCategoria: porCat, receitasPorCategoria: recPorCat };
    }

    static setBudget(state, categoria, cents) {
      const c = this.addCategory(state, categoria);
      if (!c) return { ok: false, erro: 'Informe a categoria.' };
      if (!Number.isInteger(cents) || cents < 0 || cents > this._constants.maxCents) return { ok: false, erro: 'Informe um valor válido.' };
      if (cents === 0) delete state.orcamentos[c]; else state.orcamentos[c] = cents;
      return { ok: true, categoria: c };
    }

    static budgetStatus(state, mk) {
      const gastos = this.monthReport(state, mk).despesasPorCategoria;
      return Object.keys(state.orcamentos).sort().map(cat => {
        const orc = state.orcamentos[cat], gasto = Math.max(0, gastos[cat] || 0), pct = orc > 0 ? (gasto / orc) * 100 : 0;
        return { categoria: cat, orcamento: orc, gasto, restante: orc - gasto, pct, estourou: gasto > orc, nivel: pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok' };
      });
    }

    static projection(state, hoje, dias) {
      const st = JSON.parse(JSON.stringify(state));
      RecurrenceService.materializeRecurrences(st, hoje);
      const fim = DateHelper.addDays(hoje, dias);
      const entradas = MathHelper.sum(st.income.filter(i => i.data > hoje && i.data <= fim), i => i.valor);
      const abertas = st.expenses.filter(e => !e.pago && e.vencimento <= fim);
      const atrasadas = abertas.filter(e => e.vencimento < hoje);
      const despesas = MathHelper.sum(abertas, e => e.valor);
      let dividas = 0, dividasAtrasadas = 0;
      st.debts.forEach(d => { DebtService.debtInstallments(d).forEach(p => { if (p.vencimento <= fim) { dividas += p.valor; if (p.vencimento < hoje) dividasAtrasadas += p.valor; } }); });
      const cartao = MathHelper.sum(CardService.openCycles(st).filter(c => c.total > 0 && c.vencimento <= fim), c => c.total);
      const saidas = despesas + dividas + cartao;
      return { dias, ate: fim, entradas, saidas: { despesas, dividas, cartao, total: saidas }, atrasadas: MathHelper.sum(atrasadas, e => e.valor) + dividasAtrasadas, resultado: entradas - saidas };
    }

    static projectionAll(state, hoje) { return [30, 60, 90].map(d => this.projection(state, hoje, d)); }

    static dueStatus(venc, pago, hoje) {
      if (pago) return 'pago';
      if (!venc) return '';
      if (venc < hoje) return 'atrasado';
      return venc <= DateHelper.addDays(hoje, 7) ? 'em-breve' : '';
    }

    static monthSummary(state, hoje, mk) {
      const key = mk || DateHelper.monthKey(hoje);
      const ini = DateHelper.monthStart(key);
      const entradasCaixa = MathHelper.sum(state.income.filter(x => DateHelper.monthKey(x.data) === key && x.data <= hoje), x => x.valor);
      const saidasCaixa = MathHelper.sum(state.expenses.filter(x => x.pago && DateHelper.monthKey(x.dataPagamento) === key && x.dataPagamento <= hoje), x => x.valorPago === null ? x.valor : x.valorPago);
      const entradasPrev = MathHelper.sum(state.income.filter(x => DateHelper.monthKey(x.data) === key), x => x.valor);
      const despesasPrev = MathHelper.sum(state.expenses.filter(x => DateHelper.monthKey(x.vencimento) === key), x => x.valor);
      let dividasPrev = 0;
      state.debts.forEach(d => { DebtService.debtInstallments(d).forEach(p => { if (DateHelper.monthKey(p.vencimento) === key) dividasPrev += p.valor; }); });
      const cartaoPrev = MathHelper.sum(CardService.openCycles(state).filter(c => c.total > 0 && DateHelper.monthKey(c.vencimento) === key), c => c.total);
      const saidasPrev = despesasPrev + dividasPrev + cartaoPrev;
      const atrasoDesp = state.expenses.filter(x => !x.pago && x.vencimento < ini);
      const atrasoDiv = state.debts.filter(d => !d.pago && d.vencimento < ini);
      return {
        mes: key,
        caixa: { entradas: entradasCaixa, saidas: saidasCaixa, resultado: entradasCaixa - saidasCaixa },
        previsto: { entradas: entradasPrev, saidas: saidasPrev, resultado: entradasPrev - saidasPrev, detalhe: { despesas: despesasPrev, dividas: dividasPrev, cartao: cartaoPrev } },
        atrasoAnterior: { total: MathHelper.sum(atrasoDesp, x => x.valor) + MathHelper.sum(atrasoDiv, d => d.valorParcela), qtd: atrasoDesp.length + atrasoDiv.length }
      };
    }
  }

  // ==========================================
  // ADAPTER EXPORT (Mantendo assinatura legada)
  // ==========================================
  const consts = new LedgerConstants();

  return {
    localISO: DateHelper.localISO.bind(DateHelper),
    hojeISO: DateHelper.hojeISO.bind(DateHelper),
    parseISO: DateHelper.parseISO.bind(DateHelper),
    lastDayOfMonth: DateHelper.lastDayOfMonth.bind(DateHelper),
    isValidISO: DateHelper.isValidISO.bind(DateHelper),
    makeISO: DateHelper.makeISO.bind(DateHelper),
    addDays: DateHelper.addDays.bind(DateHelper),
    addMonths: DateHelper.addMonths.bind(DateHelper),
    monthKey: DateHelper.monthKey.bind(DateHelper),
    monthStart: DateHelper.monthStart.bind(DateHelper),
    monthEnd: DateHelper.monthEnd.bind(DateHelper),
    addMonthKey: DateHelper.addMonthKey.bind(DateHelper),
    SCHEMA_VERSION: consts.schemaVersion,
    MAX_CENTS: consts.maxCents,
    CATEGORIAS_PADRAO: consts.categoriasPadrao,
    parseCents: MathHelper.parseCents.bind(MathHelper),
    safeCents: MathHelper.safeCents.bind(MathHelper),
    fmtBRL: MathHelper.fmtBRL.bind(MathHelper),
    centsToInput: MathHelper.centsToInput.bind(MathHelper),
    sum: MathHelper.sum.bind(MathHelper),
    uid: MathHelper.uid.bind(MathHelper),
    freshState: LedgerStateBuilder.freshState.bind(LedgerStateBuilder),
    normalizeState: LedgerStateBuilder.normalizeState.bind(LedgerStateBuilder),
    defaultVencimentoDia: LedgerStateBuilder.defaultVencimentoDia.bind(LedgerStateBuilder),
    makeExpense: ExpenseService.makeExpense.bind(ExpenseService),
    makeIncome: ExpenseService.makeIncome.bind(ExpenseService),
    findExpense: ExpenseService.findExpense.bind(ExpenseService),
    findDebt: DebtService.findDebt.bind(DebtService),
    expenseAjuste: ExpenseService.expenseAjuste.bind(ExpenseService),
    payExpense: ExpenseService.payExpense.bind(ExpenseService),
    unpayExpense: ExpenseService.unpayExpense.bind(ExpenseService),
    canDeleteExpense: ExpenseService.canDeleteExpense.bind(ExpenseService),
    deleteExpense: ExpenseService.deleteExpense.bind(ExpenseService),
    debtRemainingCount: DebtService.debtRemainingCount.bind(DebtService),
    debtSaldo: DebtService.debtSaldo.bind(DebtService),
    debtSaldoTotal: DebtService.debtSaldoTotal.bind(DebtService),
    debtInstallments: DebtService.debtInstallments.bind(DebtService),
    payDebtInstallment: DebtService.payDebtInstallment.bind(DebtService),
    undoDebtPayment: DebtService.undoDebtPayment.bind(DebtService),
    monthSummary: ReportService.monthSummary.bind(ReportService),
    dateBR: DateHelper.dateBR.bind(DateHelper),
    signedValor: CardService.signedValor.bind(CardService),
    closingDateFor: CardService.closingDateFor.bind(CardService),
    dueDateFor: CardService.dueDateFor.bind(CardService),
    openCycles: CardService.openCycles.bind(CardService),
    faturaDespesa: CardService.faturaDespesa.bind(CardService),
    faturaEmAberto: CardService.faturaEmAberto.bind(CardService),
    cardOpenTotal: CardService.cardOpenTotal.bind(CardService),
    cardInvoicesUnpaid: CardService.cardInvoicesUnpaid.bind(CardService),
    cardUsed: CardService.cardUsed.bind(CardService),
    cardAvailable: CardService.cardAvailable.bind(CardService),
    splitInstallments: CardService.splitInstallments.bind(CardService),
    addCardPurchase: CardService.addCardPurchase.bind(CardService),
    closeInvoice: CardService.closeInvoice.bind(CardService),
    reopenInvoice: CardService.reopenInvoice.bind(CardService),
    deleteCardItem: CardService.deleteCardItem.bind(CardService),
    addCategory: ReportService.addCategory.bind(ReportService),
    monthReport: ReportService.monthReport.bind(ReportService),
    setBudget: ReportService.setBudget.bind(ReportService),
    budgetStatus: ReportService.budgetStatus.bind(ReportService),
    HORIZONTE_DIAS: consts.horizonteDias,
    addRecurrence: RecurrenceService.addRecurrence.bind(RecurrenceService),
    materializeRecurrences: RecurrenceService.materializeRecurrences.bind(RecurrenceService),
    dueStatus: ReportService.dueStatus.bind(ReportService),
    setRecurrenceActive: RecurrenceService.setRecurrenceActive.bind(RecurrenceService),
    removeRecurrence: RecurrenceService.removeRecurrence.bind(RecurrenceService),
    projection: ReportService.projection.bind(ReportService),
    projectionAll: ReportService.projectionAll.bind(ReportService),

    CryptoAdapter,
    LedgerConstants,
    DateHelper,
    MathHelper,
    LedgerStateBuilder,
    ExpenseService,
    DebtService,
    CardService,
    RecurrenceService,
    ReportService
  };
});
