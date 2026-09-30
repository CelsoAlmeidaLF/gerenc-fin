/* Motor de cálculo do Livro-Caixa: funções puras, sem DOM, sem armazenamento.
 * UMD simples: no navegador expõe window.LedgerEngine; no Node usa module.exports.
 * Valores monetários são SEMPRE inteiros em centavos; datas são strings ISO locais (AAAA-MM-DD). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LedgerEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- datas (sempre locais, nunca toISOString) ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  /** Data local do objeto Date no formato AAAA-MM-DD (C1). */
  function localISO(date) { return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()); }
  /** "Hoje" local; recalculado a cada chamada (M7). `now` é injetável para testes. */
  function hojeISO(now) { return localISO(now instanceof Date ? now : new Date()); }
  function parseISO(iso) { var p = String(iso).split('-'); return { y: +p[0], m: +p[1], d: +p[2] }; }
  function lastDayOfMonth(y, m) { return new Date(y, m, 0).getDate(); }
  function isValidISO(text) {
    if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
    var p = parseISO(text);
    return p.m >= 1 && p.m <= 12 && p.d >= 1 && p.d <= lastDayOfMonth(p.y, p.m);
  }
  function makeISO(y, m, d) { return String(y).padStart(4, '0') + '-' + pad(m) + '-' + pad(d); }
  function addDays(iso, n) { var p = parseISO(iso); return localISO(new Date(p.y, p.m - 1, p.d + n)); }
  /** Soma n meses mantendo o dia `dia` (padrão: dia de iso), limitado ao último dia do mês (A5, B4). */
  function addMonths(iso, n, dia) {
    var p = parseISO(iso), want = dia || p.d;
    var total = p.y * 12 + (p.m - 1) + n, y = Math.floor(total / 12), m = (total % 12 + 12) % 12 + 1;
    return makeISO(y, m, Math.min(want, lastDayOfMonth(y, m)));
  }
  function monthKey(iso) { return iso ? String(iso).slice(0, 7) : ''; }
  function monthStart(mk) { return mk + '-01'; }
  function monthEnd(mk) { var p = mk.split('-'); return makeISO(+p[0], +p[1], lastDayOfMonth(+p[0], +p[1])); }
  function addMonthKey(mk, n) { return monthKey(addMonths(mk + '-01', n, 1)); }

  // ---------- dinheiro: sempre centavos inteiros (A6) ----------
  var SCHEMA_VERSION = 2;               // 1 = legado (valores em reais, float); 2 = centavos inteiros
  var MAX_CENTS = 99999999999;          // R$ 999.999.999,99 (B5)
  var CATEGORIAS_PADRAO = ['Moradia', 'Alimentação', 'Transporte', 'Saúde', 'Educação', 'Lazer', 'Cartão', 'Dívidas', 'Salário', 'Outros'];

  /** Converte texto/número em reais ("12,34", "1.234,56", 12.34) para centavos inteiros, sem passar por float. Retorna null se inválido. */
  function parseCents(value) {
    var s;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      s = String(value);
      if (/e/i.test(s)) return Math.round(value * 100);
    } else if (typeof value === 'string') {
      s = value.trim().replace(/^R\$\s*/i, '').replace(/\s+/g, '');
    } else return null;
    var neg = false;
    if (s[0] === '-') { neg = true; s = s.slice(1); } else if (s[0] === '+') s = s.slice(1);
    if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
    var lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.'), intPart, frac = '';
    if (lastComma >= 0 && lastDot >= 0) {                      // 1.234,56  ou  1,234.56
      var decPos = Math.max(lastComma, lastDot);
      intPart = s.slice(0, decPos).replace(/[.,]/g, ''); frac = s.slice(decPos + 1);
    } else if (lastComma >= 0) {                               // 12,34
      if (s.indexOf(',') !== lastComma) return null;
      intPart = s.slice(0, lastComma); frac = s.slice(lastComma + 1);
    } else if (lastDot >= 0) {                                 // 12.34 ou 1.234.567
      if (s.indexOf('.') !== lastDot) { intPart = s.replace(/\./g, ''); }
      else { intPart = s.slice(0, lastDot); frac = s.slice(lastDot + 1); }
    } else intPart = s;
    if (!/^\d*$/.test(intPart) || !/^\d*$/.test(frac)) return null;
    var cents = (parseInt(intPart || '0', 10) * 100) + parseInt((frac + '00').slice(0, 2), 10);
    if (frac.length > 2 && frac.charCodeAt(2) >= 53) cents += 1;   // arredonda meio-para-cima no 3º dígito
    return neg ? -cents : cents;
  }
  /** Centavos válidos (inteiro, 0..MAX_CENTS) ou 0. `emCentavos` indica que o valor já está em centavos (schema 2). */
  function safeCents(value, emCentavos) {
    var n = emCentavos ? Number(value) : parseCents(typeof value === 'number' || typeof value === 'string' ? value : null);
    if (emCentavos) n = Number.isFinite(n) ? Math.round(n) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= MAX_CENTS ? n : 0;
  }
  /** Formata centavos como BRL apenas na hora de exibir. */
  function fmtBRL(cents) {
    return ((Number(cents) || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  /** Centavos -> texto para <input type=number> ("12.34"), sem float. */
  function centsToInput(cents) {
    cents = Math.round(Number(cents) || 0); var neg = cents < 0; if (neg) cents = -cents;
    return (neg ? '-' : '') + Math.floor(cents / 100) + '.' + pad(cents % 100);
  }
  function sum(list, fn) { var t = 0; for (var i = 0; i < list.length; i++) t += fn(list[i]); return t; }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function safeId(value, vazioOk) {
    var id = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    return id || (vazioOk ? '' : uid());
  }
  function safeText(value) { return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200); }
  function safeDate(value) { return isValidISO(String(value || '')) ? String(value) : ''; }
  function safeInt(value, min, max, def) {
    var n = Math.trunc(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  }

  function freshState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      categorias: CATEGORIAS_PADRAO.slice(),
      orcamentos: {},
      contas: [],
      reconciliacao: {},
      recorrencias: [],
      expenses: [],
      income: [],
      card: { limite: 0, fechamento: 1, vencimentoDia: 11, lancamentos: [], faturas: [] },
      debts: []
    };
  }
  function defaultVencimentoDia(fechamento) { var d = fechamento + 10; return d > 31 ? d - 30 : d; }

  /** Valida e normaliza qualquer estado (salvo, importado ou legado). Nunca lança; retorna um estado novo no schema atual. */
  function normalizeState(parsed) {
    var source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    var card = source.card && typeof source.card === 'object' ? source.card : {};
    var emCentavos = Number(source.schemaVersion) >= 2;
    var money = function (v) { return safeCents(v, emCentavos); };
    var list = function (v) { return Array.isArray(v) ? v.slice(0, 10000).filter(function (x) { return x && typeof x === 'object'; }) : []; };
    var out = freshState();
    var cats = {};
    CATEGORIAS_PADRAO.forEach(function (c) { cats[c] = true; });
    (Array.isArray(source.categorias) ? source.categorias : []).slice(0, 100).forEach(function (c) { c = safeText(c).slice(0, 40); if (c) cats[c] = true; });
    var addCat = function (c) { c = safeText(c).slice(0, 40); if (c) cats[c] = true; return c; };
    var cat = function (v, def) { return addCat(v) || def || 'Outros'; };
    var contas = {};

    out.contas = list(source.contas).slice(0, 50).map(function (x) {
      return { id: safeId(x.id), nome: safeText(x.nome) || 'Conta', saldoInicial: safeSigned(x.saldoInicial, emCentavos), dataSaldoInicial: safeDate(x.dataSaldoInicial) };
    }).filter(function (x) { return x.dataSaldoInicial; });
    out.contas.forEach(function (c) { contas[c.id] = true; });
    var contaId = function (v) { v = safeId(v, true); return contas[v] ? v : ''; };

    out.expenses = list(source.expenses).map(function (x) {
      var valor = money(x.valor), pago = x.pago === true, venc = safeDate(x.vencimento);
      var dataPag = safeDate(x.dataPagamento) || (pago ? venc : '');
      var o = x.origem && typeof x.origem === 'object' ? x.origem : null;
      var tipoOrigem = o && (o.tipo === 'fatura' || o.tipo === 'divida') ? o.tipo : '';
      return {
        id: safeId(x.id), valor: valor, descricao: safeText(x.descricao), vencimento: venc, pago: pago,
        dataPagamento: pago ? dataPag : null,
        valorPago: pago ? (x.valorPago === null || x.valorPago === undefined ? valor : money(x.valorPago)) : null,
        categoria: cat(x.categoria), natureza: x.natureza === 'fixa' ? 'fixa' : 'variavel',
        contaId: contaId(x.contaId), conferido: x.conferido === true && pago,
        origem: tipoOrigem ? { tipo: tipoOrigem, id: safeId(o.id, true), parcela: safeInt(o.parcela, 0, 1200, 0) } : null,
        recorrenciaId: safeId(x.recorrenciaId, true), competencia: /^\d{4}-\d{2}$/.test(String(x.competencia || '')) ? String(x.competencia) : ''
      };
    }).filter(function (x) { return x.descricao && x.vencimento; });

    out.income = list(source.income).map(function (x) {
      return {
        id: safeId(x.id), valor: money(x.valor), descricao: safeText(x.descricao), data: safeDate(x.data),
        categoria: cat(x.categoria, 'Outros'), contaId: contaId(x.contaId), conferido: x.conferido === true,
        recorrenciaId: safeId(x.recorrenciaId, true), competencia: /^\d{4}-\d{2}$/.test(String(x.competencia || '')) ? String(x.competencia) : ''
      };
    }).filter(function (x) { return x.descricao && x.data; });

    out.card.limite = money(card.limite);
    out.card.fechamento = safeInt(card.fechamento, 1, 31, 1);
    out.card.vencimentoDia = safeInt(card.vencimentoDia, 1, 31, defaultVencimentoDia(out.card.fechamento));
    var normLanc = function (x) {
      var parcelas = safeInt(x.parcelas, 1, 120, 1);
      return {
        id: safeId(x.id), valor: money(x.valor), descricao: safeText(x.descricao), data: safeDate(x.data),
        categoria: cat(x.categoria), tipo: x.tipo === 'credito' ? 'credito' : 'compra',
        parcelas: parcelas, parcelaAtual: safeInt(x.parcelaAtual, 1, parcelas, 1),
        compraId: safeId(x.compraId, true), transporteDe: safeId(x.transporteDe, true)
      };
    };
    out.card.lancamentos = list(card.lancamentos).map(normLanc).filter(function (x) { return x.descricao && x.data; });
    out.card.faturas = list(card.faturas).map(function (x) {
      return {
        id: safeId(x.id), total: money(x.total), dataFechamento: safeDate(x.dataFechamento),
        vencimento: safeDate(x.vencimento),
        despesaId: safeId(x.despesaId, true),                       // M8: ausente fica vazio, nunca aleatório
        itens: list(x.itens).map(normLanc).filter(function (i) { return i.descricao && i.data; })
      };
    }).filter(function (x) { return x.dataFechamento; });
    // Vínculo fatura -> despesa: marca a despesa e completa o vencimento de faturas legadas.
    out.card.faturas.forEach(function (f) {
      var d = f.despesaId && out.expenses.find(function (e) { return e.id === f.despesaId; });
      if (d) { if (!d.origem) d.origem = { tipo: 'fatura', id: f.id, parcela: 0 }; if (!f.vencimento) f.vencimento = d.vencimento; }
    });

    out.debts = list(source.debts).map(function (x) {
      var parcelas = safeInt(x.parcelas, 1, 1200, 1), venc = safeDate(x.vencimento);
      var taxa = Number(x.taxa);
      return {
        id: safeId(x.id), valorParcela: money(x.valorParcela), descricao: safeText(x.descricao), parcelas: parcelas,
        parcelaAtual: safeInt(x.parcelaAtual, 1, parcelas, 1), vencimento: venc,
        diaOriginal: safeInt(x.diaOriginal, 1, 31, venc ? parseISO(venc).d : 1),
        pago: x.pago === true,
        pagas: list(x.pagas).map(function (p) { return { parcela: safeInt(p.parcela, 1, 1200, 1), vencimento: safeDate(p.vencimento), despesaId: safeId(p.despesaId, true) }; }),
        valorContratado: x.valorContratado === null || x.valorContratado === undefined ? null : money(x.valorContratado),
        taxa: Number.isFinite(taxa) && taxa >= 0 && taxa <= 1000 ? taxa : null,
        categoria: cat(x.categoria, 'Dívidas')
      };
    }).filter(function (x) { return x.descricao && x.vencimento; });

    out.recorrencias = list(source.recorrencias).map(function (x) {
      return {
        id: safeId(x.id), tipo: x.tipo === 'entrada' ? 'entrada' : 'despesa', valor: money(x.valor), descricao: safeText(x.descricao),
        dia: safeInt(x.dia, 1, 31, 1), inicio: safeDate(x.inicio), fim: safeDate(x.fim) || '', categoria: cat(x.categoria),
        natureza: x.natureza === 'variavel' ? 'variavel' : 'fixa', contaId: contaId(x.contaId), ativa: x.ativa !== false,
        ignoradas: (Array.isArray(x.ignoradas) ? x.ignoradas : []).filter(function (m) { return /^\d{4}-\d{2}$/.test(String(m)); }).slice(0, 600)
      };
    }).filter(function (x) { return x.descricao && x.inicio && x.valor > 0; });

    var orc = source.orcamentos && typeof source.orcamentos === 'object' && !Array.isArray(source.orcamentos) ? source.orcamentos : {};
    Object.keys(orc).slice(0, 100).forEach(function (k) { var c = addCat(k); var v = money(orc[k]); if (c && v > 0) out.orcamentos[c] = v; });

    var rec = source.reconciliacao && typeof source.reconciliacao === 'object' ? source.reconciliacao : {};
    Object.keys(rec).forEach(function (k) {
      if (contas[k] && rec[k] && typeof rec[k] === 'object') out.reconciliacao[k] = { saldoBanco: safeSigned(rec[k].saldoBanco, emCentavos), data: safeDate(rec[k].data) };
    });

    out.categorias = Object.keys(cats);
    return out;
  }
  /** Como safeCents, mas aceita saldos negativos (conta no vermelho). */
  function safeSigned(value, emCentavos) {
    var n = emCentavos ? Math.round(Number(value)) : parseCents(typeof value === 'number' || typeof value === 'string' ? value : null);
    return Number.isFinite(n) && Math.abs(n) <= MAX_CENTS ? n : 0;
  }

  return {
    localISO: localISO, hojeISO: hojeISO, parseISO: parseISO, lastDayOfMonth: lastDayOfMonth, isValidISO: isValidISO,
    makeISO: makeISO, addDays: addDays, addMonths: addMonths, monthKey: monthKey, monthStart: monthStart,
    monthEnd: monthEnd, addMonthKey: addMonthKey,
    SCHEMA_VERSION: SCHEMA_VERSION, MAX_CENTS: MAX_CENTS, CATEGORIAS_PADRAO: CATEGORIAS_PADRAO,
    parseCents: parseCents, safeCents: safeCents, safeSigned: safeSigned, fmtBRL: fmtBRL, centsToInput: centsToInput, sum: sum, uid: uid, freshState: freshState,
    normalizeState: normalizeState, defaultVencimentoDia: defaultVencimentoDia
  };
});
