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

  // ---------- fábricas de lançamentos (já no formato do schema atual) ----------
  function makeExpense(o) {
    return {
      id: o.id || uid(), valor: o.valor, descricao: o.descricao, vencimento: o.vencimento, pago: false, dataPagamento: null, valorPago: null,
      categoria: o.categoria || 'Outros', natureza: o.natureza === 'fixa' ? 'fixa' : 'variavel', contaId: o.contaId || '', conferido: false,
      origem: o.origem || null, recorrenciaId: o.recorrenciaId || '', competencia: o.competencia || ''
    };
  }
  function makeIncome(o) {
    return { id: o.id || uid(), valor: o.valor, descricao: o.descricao, data: o.data, categoria: o.categoria || 'Outros', contaId: o.contaId || '', conferido: false, recorrenciaId: o.recorrenciaId || '', competencia: o.competencia || '' };
  }

  // ---------- despesas: baixa, estorno, exclusão (M1, M3, M8) ----------
  function findExpense(state, id) { return state.expenses.find(function (e) { return e.id === id; }); }
  function findDebt(state, id) { return state.debts.find(function (d) { return d.id === id; }); }
  /** Diferença entre o valor pago e o valor da despesa: > 0 juros/multa, < 0 desconto (M1). */
  function expenseAjuste(e) { return e.pago && e.valorPago !== null ? e.valorPago - e.valor : 0; }
  function defaultContaId(state) { return state.contas.length ? state.contas[0].id : ''; }

  /** Dá baixa numa despesa com data e valor efetivamente pagos. `hoje` é usado só para barrar data futura. */
  function payExpense(state, id, opts, hoje) {
    var e = findExpense(state, id); opts = opts || {};
    if (!e) return { ok: false, erro: 'Despesa não encontrada.' };
    if (e.pago) return { ok: false, erro: 'Esta despesa já está paga.' };
    var data = opts.data || hoje;
    if (!isValidISO(data)) return { ok: false, erro: 'Informe uma data de pagamento válida.' };
    if (hoje && data > hoje) return { ok: false, erro: 'A data do pagamento não pode ser futura.' };
    var valorPago = opts.valorPago === undefined || opts.valorPago === null ? e.valor : opts.valorPago;
    if (!Number.isInteger(valorPago) || valorPago <= 0 || valorPago > MAX_CENTS) return { ok: false, erro: 'Informe um valor pago válido.' };
    e.pago = true; e.dataPagamento = data; e.valorPago = valorPago; e.conferido = false;
    if (opts.contaId !== undefined) e.contaId = state.contas.some(function (c) { return c.id === opts.contaId; }) ? opts.contaId : '';
    return { ok: true, ajuste: valorPago - e.valor };
  }
  /** Estorna um pagamento: a despesa volta a "em aberto". Para parcela de dívida, desfaz a parcela. */
  function unpayExpense(state, id) {
    var e = findExpense(state, id);
    if (!e) return { ok: false, erro: 'Despesa não encontrada.' };
    if (!e.pago) return { ok: false, erro: 'Esta despesa não está paga.' };
    if (e.origem && e.origem.tipo === 'divida') return undoDebtPayment(state, e.origem.id, e.id);
    e.pago = false; e.dataPagamento = null; e.valorPago = null; e.conferido = false;
    return { ok: true };
  }
  /** Regras de exclusão: despesa vinculada a fatura ou a parcela de dívida não pode sumir em silêncio (M8). */
  function canDeleteExpense(state, id) {
    var e = findExpense(state, id);
    if (!e) return { ok: false, motivo: 'Despesa não encontrada.' };
    if (e.origem && e.origem.tipo === 'fatura') return { ok: false, vinculo: 'fatura', motivo: 'Esta despesa é a fatura do cartão. Para removê-la, reabra a fatura na aba Cartão (estorne o pagamento antes, se já estiver paga).' };
    if (e.origem && e.origem.tipo === 'divida') return { ok: false, vinculo: 'divida', motivo: 'Esta despesa é o pagamento de uma parcela de dívida. Para desfazer, estorne o pagamento (a parcela volta para a aba Dívidas).' };
    return { ok: true };
  }
  function deleteExpense(state, id) {
    var chk = canDeleteExpense(state, id);
    if (!chk.ok) return chk;
    var e = findExpense(state, id);
    if (e.recorrenciaId && e.competencia) {           // não recria a ocorrência que o usuário apagou (M5)
      var r = state.recorrencias.find(function (x) { return x.id === e.recorrenciaId; });
      if (r && r.ignoradas.indexOf(e.competencia) < 0) r.ignoradas.push(e.competencia);
    }
    state.expenses = state.expenses.filter(function (x) { return x.id !== id; });
    return { ok: true };
  }

  // ---------- dívidas (C2, A5, M1-M3) ----------
  function debtRemainingCount(d) { return d.pago ? 0 : d.parcelas - d.parcelaAtual + 1; }
  /** Saldo devedor nominal: parcelas restantes x valor da parcela (sem juros futuros) (M2). */
  function debtSaldo(d) { return debtRemainingCount(d) * d.valorParcela; }
  function debtSaldoTotal(state) { return sum(state.debts, debtSaldo); }
  /** Cronograma das parcelas ainda não pagas, preservando o dia original do mês (A5). */
  function debtInstallments(d) {
    var out = [];
    for (var k = 0; k < debtRemainingCount(d); k++) {
      out.push({ parcela: d.parcelaAtual + k, vencimento: k === 0 ? d.vencimento : addMonths(d.vencimento, k, d.diaOriginal), valor: d.valorParcela });
    }
    return out;
  }
  /** Paga a parcela atual: gera despesa paga vinculada, avança a parcela/vencimento (ou quita). */
  function payDebtInstallment(state, debtId, opts, hoje) {
    var d = findDebt(state, debtId); opts = opts || {};
    if (!d) return { ok: false, erro: 'Dívida não encontrada.' };
    if (d.pago) return { ok: false, erro: 'Esta dívida já está quitada.' };
    var data = opts.data || hoje;
    if (!isValidISO(data)) return { ok: false, erro: 'Informe uma data de pagamento válida.' };
    if (hoje && data > hoje) return { ok: false, erro: 'A data do pagamento não pode ser futura.' };
    var valorPago = opts.valorPago === undefined || opts.valorPago === null ? d.valorParcela : opts.valorPago;
    if (!Number.isInteger(valorPago) || valorPago <= 0 || valorPago > MAX_CENTS) return { ok: false, erro: 'Informe um valor pago válido.' };
    var parcela = d.parcelaAtual, venc = d.vencimento;
    var despesa = {
      id: uid(), valor: d.valorParcela, descricao: d.descricao + ' (parcela ' + parcela + '/' + d.parcelas + ')', vencimento: venc,
      pago: true, dataPagamento: data, valorPago: valorPago, categoria: d.categoria, natureza: 'fixa',
      contaId: opts.contaId !== undefined && state.contas.some(function (c) { return c.id === opts.contaId; }) ? opts.contaId : '',
      conferido: false, origem: { tipo: 'divida', id: d.id, parcela: parcela }, recorrenciaId: '', competencia: ''
    };
    state.expenses.push(despesa);
    d.pagas.push({ parcela: parcela, vencimento: venc, despesaId: despesa.id });
    if (d.parcelaAtual >= d.parcelas) d.pago = true;
    else { d.parcelaAtual += 1; d.vencimento = addMonths(venc, 1, d.diaOriginal); }
    return { ok: true, despesa: despesa, quitada: d.pago };
  }
  /** Desfaz o último pagamento de parcela: remove a despesa gerada e volta parcela e vencimento (M3). */
  function undoDebtPayment(state, debtId, despesaId) {
    var d = findDebt(state, debtId);
    if (!d) return { ok: false, erro: 'Dívida não encontrada.' };
    var ultima = d.pagas[d.pagas.length - 1];
    if (!ultima) return { ok: false, erro: 'Não há pagamento registrado para desfazer.' };
    if (despesaId && ultima.despesaId !== despesaId) return { ok: false, erro: 'Só é possível estornar a parcela mais recente. Estorne primeiro as parcelas seguintes.' };
    state.expenses = state.expenses.filter(function (e) { return e.id !== ultima.despesaId; });
    d.pagas.pop();
    d.parcelaAtual = ultima.parcela; d.vencimento = ultima.vencimento; d.pago = false;
    return { ok: true, parcela: ultima.parcela };
  }

  // ---------- cartão de crédito: ciclos, faturas, parcelas e limite (C3, A3, A4, B1, B4) ----------
  function dateBR(iso) { if (!iso) return ''; var p = String(iso).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  /** Valor com sinal: compra soma, crédito/estorno subtrai (B1). */
  function signedValor(l) { return l.tipo === 'credito' ? -l.valor : l.valor; }
  /** Data de fechamento do ciclo que contém `iso`. Compras até o dia do fechamento (inclusive) entram na fatura que fecha nele.
   *  Em meses curtos o fechamento vai para o último dia do mês (B4). */
  function closingDateFor(iso, fechamentoDia) {
    var p = parseISO(iso), fecha = Math.min(fechamentoDia, lastDayOfMonth(p.y, p.m));
    if (p.d <= fecha) return makeISO(p.y, p.m, fecha);
    return addMonths(makeISO(p.y, p.m, 1), 1, fechamentoDia);
  }
  /** Vencimento da fatura que fecha em `closingISO`: primeiro `vencimentoDia` depois do fechamento (limitado ao fim do mês). */
  function dueDateFor(closingISO, vencimentoDia) {
    var p = parseISO(closingISO), mesmo = addMonths(makeISO(p.y, p.m, 1), 0, vencimentoDia);
    return mesmo > closingISO ? mesmo : addMonths(makeISO(p.y, p.m, 1), 1, vencimentoDia);
  }
  /** Ciclos com lançamentos ainda não fechados, em ordem cronológica: [{fechamento, vencimento, itens, total}] (total líquido de créditos). */
  function openCycles(state) {
    var map = {}, card = state.card;
    card.lancamentos.forEach(function (l) {
      var f = closingDateFor(l.data, card.fechamento);
      (map[f] = map[f] || { fechamento: f, vencimento: dueDateFor(f, card.vencimentoDia), itens: [], total: 0 });
      map[f].itens.push(l); map[f].total += signedValor(l);
    });
    return Object.keys(map).sort().map(function (k) { return map[k]; });
  }
  function faturaDespesa(state, f) { return f.despesaId ? findExpense(state, f.despesaId) : undefined; }
  /** Fatura ainda pesa no limite? Sim, enquanto a despesa vinculada não foi paga. Sem vínculo (dado legado) conta como quitada. */
  function faturaEmAberto(state, f) { var d = faturaDespesa(state, f); return !!d && !d.pago; }
  function cardOpenTotal(state) { return sum(state.card.lancamentos, signedValor); }
  function cardInvoicesUnpaid(state) { return sum(state.card.faturas.filter(function (f) { return faturaEmAberto(state, f); }), function (f) { return f.total; }); }
  /** Limite usado = lançamentos em aberto (inclui parcelas futuras) + faturas fechadas ainda não pagas (C3, A4). */
  function cardUsed(state) { return Math.max(0, cardOpenTotal(state) + cardInvoicesUnpaid(state)); }
  function cardAvailable(state) { return Math.max(0, state.card.limite - cardUsed(state)); }

  /** Divide o total em n parcelas em centavos; o resto da divisão fica na primeira parcela. */
  function splitInstallments(total, n) {
    var base = Math.floor(total / n), resto = total - base * n, out = [];
    for (var i = 0; i < n; i++) out.push(base + (i === 0 ? resto : 0));
    return out;
  }
  /** Lança compra (ou crédito) no cartão. Compra parcelada gera uma linha por parcela, cada uma na data do mês
   *  correspondente, para cair nas faturas seguintes (A4). Retorna as linhas criadas. */
  function addCardPurchase(state, o) {
    var tipo = o.tipo === 'credito' ? 'credito' : 'compra';
    var n = tipo === 'credito' ? 1 : safeInt(o.parcelas, 1, 120, 1);
    var valores = splitInstallments(o.valor, n), dia = parseISO(o.data).d, compraId = n > 1 ? uid() : '', criadas = [];
    for (var i = 0; i < n; i++) {
      criadas.push({ id: uid(), valor: valores[i], descricao: o.descricao, data: i === 0 ? o.data : addMonths(o.data, i, dia), categoria: o.categoria || 'Outros', tipo: tipo, parcelas: n, parcelaAtual: i + 1, compraId: compraId, transporteDe: '' });
    }
    Array.prototype.push.apply(state.card.lancamentos, criadas);
    return criadas;
  }
  /** Fecha a fatura do ciclo `fechamentoISO` (só depois da data de fechamento). Leva junto ciclos anteriores ainda abertos.
   *  Gera a despesa vinculada com o vencimento calculado a partir do dia de vencimento (A3). */
  function closeInvoice(state, fechamentoISO, hoje) {
    var ciclos = openCycles(state), alvo = ciclos.find(function (c) { return c.fechamento === fechamentoISO; });
    if (!alvo) return { ok: false, erro: 'Ciclo não encontrado.' };
    if (alvo.fechamento > hoje) return { ok: false, erro: 'Este ciclo só fecha em ' + dateBR(alvo.fechamento) + '.' };
    var incluidos = ciclos.filter(function (c) { return c.fechamento <= alvo.fechamento; }), itens = [];
    incluidos.forEach(function (c) { Array.prototype.push.apply(itens, c.itens); });
    var liquido = sum(itens, signedValor), faturaId = uid(), despesa = null;
    var fatura = { id: faturaId, total: Math.max(0, liquido), dataFechamento: alvo.fechamento, vencimento: alvo.vencimento, despesaId: '', itens: itens };
    if (liquido > 0) {
      despesa = makeExpense({ valor: liquido, descricao: 'Fatura do cartão (fechamento ' + dateBR(alvo.fechamento) + ')', vencimento: alvo.vencimento, categoria: 'Cartão', origem: { tipo: 'fatura', id: faturaId, parcela: 0 } });
      state.expenses.push(despesa); fatura.despesaId = despesa.id;
    }
    var ids = {}; itens.forEach(function (l) { ids[l.id] = true; });
    state.card.lancamentos = state.card.lancamentos.filter(function (l) { return !ids[l.id]; });
    if (liquido < 0) {                                // crédito maior que as compras: sobra abate a próxima fatura
      state.card.lancamentos.push({ id: uid(), valor: -liquido, descricao: 'Crédito da fatura de ' + dateBR(alvo.fechamento), data: addDays(alvo.fechamento, 1), categoria: 'Cartão', tipo: 'credito', parcelas: 1, parcelaAtual: 1, compraId: '', transporteDe: faturaId });
    }
    state.card.faturas.push(fatura);
    return { ok: true, fatura: fatura, despesa: despesa };
  }
  /** Exclui um lançamento do cartão; se for parcela de compra parcelada, remove todas as parcelas ainda em aberto da compra. */
  function deleteCardItem(state, id) {
    var l = state.card.lancamentos.find(function (x) { return x.id === id; });
    if (!l) return { ok: false, erro: 'Lançamento não encontrado.' };
    var antes = state.card.lancamentos.length;
    state.card.lancamentos = state.card.lancamentos.filter(function (x) { return l.compraId ? x.compraId !== l.compraId : x.id !== id; });
    return { ok: true, removidos: antes - state.card.lancamentos.length };
  }
  /** Reabre uma fatura ainda não paga: devolve os lançamentos ao cartão e remove a despesa vinculada (M8). */
  function reopenInvoice(state, faturaId) {
    var f = state.card.faturas.find(function (x) { return x.id === faturaId; });
    if (!f) return { ok: false, erro: 'Fatura não encontrada.' };
    var d = faturaDespesa(state, f);
    if (d && d.pago) return { ok: false, erro: 'Esta fatura já foi paga. Estorne o pagamento em Despesas antes de reabri-la.' };
    state.card.lancamentos = state.card.lancamentos.filter(function (l) { return l.transporteDe !== f.id; });
    Array.prototype.push.apply(state.card.lancamentos, f.itens);
    if (d) state.expenses = state.expenses.filter(function (e) { return e.id !== d.id; });
    state.card.faturas = state.card.faturas.filter(function (x) { return x.id !== f.id; });
    return { ok: true, devolvidos: f.itens.length };
  }

  // ---------- contas, saldo real e conciliação (A2) ----------
  function addAccount(state, o) {
    var nome = safeText(o.nome) || 'Conta';
    if (!isValidISO(o.dataSaldoInicial)) return { ok: false, erro: 'Informe a data do saldo inicial.' };
    var saldo = safeSigned(o.saldoInicial, true);
    var conta = { id: uid(), nome: nome, saldoInicial: saldo, dataSaldoInicial: o.dataSaldoInicial };
    state.contas.push(conta);
    return { ok: true, conta: conta };
  }
  function removeAccount(state, id) {
    state.contas = state.contas.filter(function (c) { return c.id !== id; });
    state.expenses.forEach(function (e) { if (e.contaId === id) e.contaId = ''; });
    state.income.forEach(function (i) { if (i.contaId === id) i.contaId = ''; });
    state.recorrencias.forEach(function (r) { if (r.contaId === id) r.contaId = ''; });
    delete state.reconciliacao[id];
  }
  /** Conta a que o item pertence; itens sem conta valem para a primeira conta cadastrada. */
  function contaDoItem(state, item) {
    if (!state.contas.length) return '';
    return state.contas.some(function (c) { return c.id === item.contaId; }) ? item.contaId : state.contas[0].id;
  }
  /** Movimentos realizados (entradas com data <= hoje e despesas pagas) a partir do saldo inicial da conta, mais recentes primeiro.
   *  `valor` vem com sinal: entrada positiva, saída negativa. */
  function realizedMovements(state, hoje, contaId) {
    var out = [], contas = {};
    state.contas.forEach(function (c) { contas[c.id] = c; });
    state.income.forEach(function (i) {
      var cid = contaDoItem(state, i), c = contas[cid];
      if (!c || (contaId && cid !== contaId) || i.data < c.dataSaldoInicial || i.data > hoje) return;
      out.push({ tipo: 'entrada', id: i.id, contaId: cid, data: i.data, descricao: i.descricao, valor: i.valor, conferido: !!i.conferido });
    });
    state.expenses.forEach(function (e) {
      if (!e.pago) return;
      var cid = contaDoItem(state, e), c = contas[cid];
      if (!c || (contaId && cid !== contaId) || e.dataPagamento < c.dataSaldoInicial || e.dataPagamento > hoje) return;
      out.push({ tipo: 'saida', id: e.id, contaId: cid, data: e.dataPagamento, descricao: e.descricao, valor: -(e.valorPago === null ? e.valor : e.valorPago), conferido: !!e.conferido });
    });
    return out.sort(function (a, b) { return b.data.localeCompare(a.data) || (a.id < b.id ? -1 : 1); });
  }
  /** Saldo atual = saldo inicial + entradas realizadas − saídas realizadas (desde a data do saldo inicial). */
  function saldoConta(state, contaId, hoje) {
    var c = state.contas.find(function (x) { return x.id === contaId; });
    if (!c) return null;
    return c.saldoInicial + sum(realizedMovements(state, hoje, contaId), function (m) { return m.valor; });
  }
  /** Saldo total das contas; null se ainda não há conta cadastrada. */
  function saldoAtual(state, hoje) {
    if (!state.contas.length) return null;
    return sum(state.contas, function (c) { return saldoConta(state, c.id, hoje); });
  }
  function setConferido(state, tipo, id, valor) {
    var item = tipo === 'entrada' ? state.income.find(function (x) { return x.id === id; }) : findExpense(state, id);
    if (!item || (tipo !== 'entrada' && !item.pago)) return false;
    item.conferido = !!valor; return true;
  }
  /** Compara o saldo informado pelo banco com o do app.
   *  status: "ok" (bate), "pendentes" (a diferença some se todos os lançamentos pendentes de conferência já constarem no banco),
   *  "divergente" (sobra diferença que não se explica pelos pendentes). */
  function reconcile(state, contaId, saldoBanco, hoje) {
    var c = state.contas.find(function (x) { return x.id === contaId; });
    if (!c) return { ok: false, erro: 'Conta não encontrada.' };
    var movs = realizedMovements(state, hoje, contaId);
    var app = c.saldoInicial + sum(movs, function (m) { return m.valor; });
    var conciliado = c.saldoInicial + sum(movs.filter(function (m) { return m.conferido; }), function (m) { return m.valor; });
    var pend = movs.filter(function (m) { return !m.conferido; });
    var status = saldoBanco === app ? 'ok' : saldoBanco === conciliado ? 'pendentes' : 'divergente';
    return {
      ok: true, saldoApp: app, saldoBanco: saldoBanco, diferenca: saldoBanco - app, saldoConciliado: conciliado,
      diferencaConciliado: saldoBanco - conciliado, pendentes: { qtd: pend.length, liquido: sum(pend, function (m) { return m.valor; }) }, status: status
    };
  }

  // ---------- categorias, relatório mensal e orçamento (M4) ----------
  function addCategory(state, nome) {
    var c = safeText(nome).slice(0, 40);
    if (!c) return '';
    if (state.categorias.indexOf(c) < 0) state.categorias.push(c);
    return c;
  }
  /** Relatório do mês por competência: receitas, despesas fixas, variáveis, dívidas e resultado.
   *  - despesas comuns entram pelo vencimento; compras no cartão pela data da compra (cada parcela no seu mês),
   *    sem contar de novo a despesa da fatura; parcelas de dívida pelo vencimento (pagas ou em aberto). */
  function monthReport(state, mk) {
    var receitas = 0, fixas = 0, variaveis = 0, dividas = 0, porCat = {}, recPorCat = {};
    var soma = function (mapa, cat, v) { mapa[cat] = (mapa[cat] || 0) + v; };
    state.income.forEach(function (i) { if (monthKey(i.data) === mk) { receitas += i.valor; soma(recPorCat, i.categoria, i.valor); } });
    state.expenses.forEach(function (e) {
      if (monthKey(e.vencimento) !== mk) return;
      var o = e.origem && e.origem.tipo;
      if (o === 'divida') { dividas += e.valor; soma(porCat, e.categoria, e.valor); }
      else if (o === 'fatura') return;                                // já contada pelas compras do cartão
      else { if (e.natureza === 'fixa') fixas += e.valor; else variaveis += e.valor; soma(porCat, e.categoria, e.valor); }
    });
    state.debts.forEach(function (d) {
      debtInstallments(d).forEach(function (p) { if (monthKey(p.vencimento) === mk) { dividas += p.valor; soma(porCat, d.categoria, p.valor); } });
    });
    var itens = state.card.lancamentos.slice();
    state.card.faturas.forEach(function (f) {
      if (f.itens.length) Array.prototype.push.apply(itens, f.itens);
      else { var d = faturaDespesa(state, f); if (d && monthKey(d.vencimento) === mk) { variaveis += d.valor; soma(porCat, 'Cartão', d.valor); } }   // fatura legada sem itens
    });
    itens.forEach(function (l) {
      if (l.transporteDe || monthKey(l.data) !== mk) return;
      var v = signedValor(l); variaveis += v; soma(porCat, l.categoria, v);
    });
    var totalDespesas = fixas + variaveis + dividas;
    return { mes: mk, receitas: receitas, fixas: fixas, variaveis: variaveis, dividas: dividas, totalDespesas: totalDespesas, resultado: receitas - totalDespesas, despesasPorCategoria: porCat, receitasPorCategoria: recPorCat };
  }
  /** Define (ou remove, com valor 0) o orçamento mensal de uma categoria. */
  function setBudget(state, categoria, cents) {
    var c = addCategory(state, categoria);
    if (!c) return { ok: false, erro: 'Informe a categoria.' };
    if (!Number.isInteger(cents) || cents < 0 || cents > MAX_CENTS) return { ok: false, erro: 'Informe um valor válido.' };
    if (cents === 0) delete state.orcamentos[c]; else state.orcamentos[c] = cents;
    return { ok: true, categoria: c };
  }
  /** Gasto x orçamento por categoria. nivel: "ok" (<70%), "warn" (>=70%), "danger" (>=90%), mesmos alertas do limite do cartão. */
  function budgetStatus(state, mk) {
    var gastos = monthReport(state, mk).despesasPorCategoria;
    return Object.keys(state.orcamentos).sort().map(function (cat) {
      var orc = state.orcamentos[cat], gasto = Math.max(0, gastos[cat] || 0), pct = orc > 0 ? (gasto / orc) * 100 : 0;
      return { categoria: cat, orcamento: orc, gasto: gasto, restante: orc - gasto, pct: pct, estourou: gasto > orc, nivel: pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok' };
    });
  }

  // ---------- lançamentos recorrentes mensais (M5) ----------
  var HORIZONTE_DIAS = 90;
  function addRecurrence(state, o) {
    if (!isValidISO(o.inicio)) return { ok: false, erro: 'Informe a data da primeira ocorrência.' };
    if (!Number.isInteger(o.valor) || o.valor <= 0 || o.valor > MAX_CENTS) return { ok: false, erro: 'Informe um valor válido.' };
    var descricao = safeText(o.descricao);
    if (!descricao) return { ok: false, erro: 'Informe a descrição.' };
    var r = {
      id: uid(), tipo: o.tipo === 'entrada' ? 'entrada' : 'despesa', valor: o.valor, descricao: descricao, dia: parseISO(o.inicio).d, inicio: o.inicio,
      fim: isValidISO(o.fim) ? o.fim : '', categoria: addCategory(state, o.categoria) || 'Outros', natureza: o.natureza === 'variavel' ? 'variavel' : 'fixa',
      contaId: o.contaId || '', ativa: true, ignoradas: []
    };
    state.recorrencias.push(r);
    return { ok: true, recorrencia: r };
  }
  /** Gera as ocorrências que faltam de cada modelo ativo até `HORIZONTE_DIAS` à frente. Idempotente: uma ocorrência por
   *  modelo e mês (competência); meses apagados pelo usuário (ignoradas) não voltam. Dia 31 vira o último dia do mês. */
  function materializeRecurrences(state, hoje) {
    var ate = monthKey(addDays(hoje, HORIZONTE_DIAS)), criadas = 0;
    state.recorrencias.forEach(function (r) {
      if (!r.ativa) return;
      var tem = {};
      (r.tipo === 'entrada' ? state.income : state.expenses).forEach(function (x) { if (x.recorrenciaId === r.id && x.competencia) tem[x.competencia] = true; });
      var mk = monthKey(r.inicio);
      for (var guard = 0; mk <= ate && guard < 1200; guard++, mk = addMonthKey(mk, 1)) {
        var data = addMonths(monthStart(mk), 0, r.dia);
        if (data < r.inicio || (r.fim && data > r.fim) || tem[mk] || r.ignoradas.indexOf(mk) >= 0) continue;
        if (r.tipo === 'entrada') state.income.push(makeIncome({ valor: r.valor, descricao: r.descricao, data: data, categoria: r.categoria, contaId: r.contaId, recorrenciaId: r.id, competencia: mk }));
        else state.expenses.push(makeExpense({ valor: r.valor, descricao: r.descricao, vencimento: data, categoria: r.categoria, natureza: r.natureza, contaId: r.contaId, recorrenciaId: r.id, competencia: mk }));
        criadas++;
      }
    });
    return criadas;
  }
  /** Pausa/retoma um modelo. Pausar só impede novas ocorrências; as já geradas ficam. */
  function setRecurrenceActive(state, id, ativa) {
    var r = state.recorrencias.find(function (x) { return x.id === id; });
    if (r) r.ativa = !!ativa;
    return !!r;
  }
  /** Exclui o modelo e as ocorrências futuras ainda não pagas (vencimento/data depois de hoje); o que já passou fica. */
  function removeRecurrence(state, id, hoje) {
    state.recorrencias = state.recorrencias.filter(function (r) { return r.id !== id; });
    state.expenses = state.expenses.filter(function (e) { return !(e.recorrenciaId === id && !e.pago && e.vencimento > hoje); });
    state.income = state.income.filter(function (i) { return !(i.recorrenciaId === id && i.data > hoje); });
    state.expenses.forEach(function (e) { if (e.recorrenciaId === id) { e.recorrenciaId = ''; e.competencia = ''; } });
    state.income.forEach(function (i) { if (i.recorrenciaId === id) { i.recorrenciaId = ''; i.competencia = ''; } });
  }

  // ---------- projeção de caixa 30/60/90 dias (M6) ----------
  /** Projeta o caixa até `dias` à frente: despesas em aberto (inclui atrasadas e faturas já fechadas), parcelas de dívidas,
   *  faturas previstas dos ciclos abertos do cartão e entradas esperadas (datas futuras, inclusive recorrentes).
   *  Parte do saldo atual das contas (0 se não houver conta). Não altera o estado. */
  function projection(state, hoje, dias) {
    var st = JSON.parse(JSON.stringify(state));
    materializeRecurrences(st, hoje);
    var fim = addDays(hoje, dias);
    var entradas = sum(st.income.filter(function (i) { return i.data > hoje && i.data <= fim; }), function (i) { return i.valor; });
    var abertas = st.expenses.filter(function (e) { return !e.pago && e.vencimento <= fim; });
    var atrasadas = abertas.filter(function (e) { return e.vencimento < hoje; });
    var despesas = sum(abertas, function (e) { return e.valor; });
    var dividas = 0, dividasAtrasadas = 0;
    st.debts.forEach(function (d) { debtInstallments(d).forEach(function (p) { if (p.vencimento <= fim) { dividas += p.valor; if (p.vencimento < hoje) dividasAtrasadas += p.valor; } }); });
    var cartao = sum(openCycles(st).filter(function (c) { return c.total > 0 && c.vencimento <= fim; }), function (c) { return c.total; });
    var saldoInicial = saldoAtual(st, hoje), saidas = despesas + dividas + cartao;
    return {
      dias: dias, ate: fim, temConta: saldoInicial !== null, saldoInicial: saldoInicial || 0, entradas: entradas,
      saidas: { despesas: despesas, dividas: dividas, cartao: cartao, total: saidas },
      atrasadas: sum(atrasadas, function (e) { return e.valor; }) + dividasAtrasadas,
      saldoProjetado: (saldoInicial || 0) + entradas - saidas
    };
  }
  function projectionAll(state, hoje) { return [30, 60, 90].map(function (d) { return projection(state, hoje, d); }); }

  // ---------- resumo do mês: caixa x competência (A1) ----------
  /** Resumo de um mês. `caixa` = o que de fato entrou/saiu (data de pagamento); `previsto` = vencimentos do mês
   *  (competência); `atrasoAnterior` = em aberto de meses anteriores. Todos em centavos. */
  function monthSummary(state, hoje, mk) {
    mk = mk || monthKey(hoje);
    var ini = monthStart(mk);
    var entradasCaixa = sum(state.income.filter(function (x) { return monthKey(x.data) === mk && x.data <= hoje; }), function (x) { return x.valor; });
    var saidasCaixa = sum(state.expenses.filter(function (x) { return x.pago && monthKey(x.dataPagamento) === mk && x.dataPagamento <= hoje; }), function (x) { return x.valorPago === null ? x.valor : x.valorPago; });
    var entradasPrev = sum(state.income.filter(function (x) { return monthKey(x.data) === mk; }), function (x) { return x.valor; });
    var despesasPrev = sum(state.expenses.filter(function (x) { return monthKey(x.vencimento) === mk; }), function (x) { return x.valor; });
    var dividasPrev = 0;
    state.debts.forEach(function (d) { debtInstallments(d).forEach(function (p) { if (monthKey(p.vencimento) === mk) dividasPrev += p.valor; }); });
    var cartaoPrev = sum(openCycles(state).filter(function (c) { return c.total > 0 && monthKey(c.vencimento) === mk; }), function (c) { return c.total; });
    var saidasPrev = despesasPrev + dividasPrev + cartaoPrev;
    var atrasoDesp = state.expenses.filter(function (x) { return !x.pago && x.vencimento < ini; });
    var atrasoDiv = state.debts.filter(function (d) { return !d.pago && d.vencimento < ini; });
    return {
      mes: mk,
      caixa: { entradas: entradasCaixa, saidas: saidasCaixa, resultado: entradasCaixa - saidasCaixa },
      previsto: { entradas: entradasPrev, saidas: saidasPrev, resultado: entradasPrev - saidasPrev, detalhe: { despesas: despesasPrev, dividas: dividasPrev, cartao: cartaoPrev } },
      atrasoAnterior: { total: sum(atrasoDesp, function (x) { return x.valor; }) + sum(atrasoDiv, function (d) { return d.valorParcela; }), qtd: atrasoDesp.length + atrasoDiv.length }
    };
  }

  return {
    localISO: localISO, hojeISO: hojeISO, parseISO: parseISO, lastDayOfMonth: lastDayOfMonth, isValidISO: isValidISO,
    makeISO: makeISO, addDays: addDays, addMonths: addMonths, monthKey: monthKey, monthStart: monthStart,
    monthEnd: monthEnd, addMonthKey: addMonthKey,
    SCHEMA_VERSION: SCHEMA_VERSION, MAX_CENTS: MAX_CENTS, CATEGORIAS_PADRAO: CATEGORIAS_PADRAO,
    parseCents: parseCents, safeCents: safeCents, safeSigned: safeSigned, fmtBRL: fmtBRL, centsToInput: centsToInput, sum: sum, uid: uid, freshState: freshState,
    normalizeState: normalizeState, defaultVencimentoDia: defaultVencimentoDia,
    makeExpense: makeExpense, makeIncome: makeIncome, findExpense: findExpense, findDebt: findDebt, expenseAjuste: expenseAjuste, defaultContaId: defaultContaId,
    payExpense: payExpense, unpayExpense: unpayExpense, canDeleteExpense: canDeleteExpense, deleteExpense: deleteExpense,
    debtRemainingCount: debtRemainingCount, debtSaldo: debtSaldo, debtSaldoTotal: debtSaldoTotal, debtInstallments: debtInstallments,
    payDebtInstallment: payDebtInstallment, undoDebtPayment: undoDebtPayment, monthSummary: monthSummary,
    dateBR: dateBR, signedValor: signedValor, closingDateFor: closingDateFor, dueDateFor: dueDateFor, openCycles: openCycles,
    faturaDespesa: faturaDespesa, faturaEmAberto: faturaEmAberto, cardOpenTotal: cardOpenTotal, cardInvoicesUnpaid: cardInvoicesUnpaid,
    cardUsed: cardUsed, cardAvailable: cardAvailable, splitInstallments: splitInstallments, addCardPurchase: addCardPurchase,
    closeInvoice: closeInvoice, reopenInvoice: reopenInvoice, deleteCardItem: deleteCardItem,
    addAccount: addAccount, removeAccount: removeAccount, contaDoItem: contaDoItem, realizedMovements: realizedMovements,
    saldoConta: saldoConta, saldoAtual: saldoAtual, setConferido: setConferido, reconcile: reconcile,
    addCategory: addCategory, monthReport: monthReport, setBudget: setBudget, budgetStatus: budgetStatus,
    HORIZONTE_DIAS: HORIZONTE_DIAS, addRecurrence: addRecurrence, materializeRecurrences: materializeRecurrences,
    setRecurrenceActive: setRecurrenceActive, removeRecurrence: removeRecurrence, projection: projection, projectionAll: projectionAll
  };
});
