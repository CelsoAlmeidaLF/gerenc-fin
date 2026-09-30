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
    var cartaoPrev = 0;
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
    payDebtInstallment: payDebtInstallment, undoDebtPayment: undoDebtPayment, monthSummary: monthSummary
  };
});
