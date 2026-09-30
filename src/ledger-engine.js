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

  return {
    localISO: localISO, hojeISO: hojeISO, parseISO: parseISO, lastDayOfMonth: lastDayOfMonth, isValidISO: isValidISO,
    makeISO: makeISO, addDays: addDays, addMonths: addMonths, monthKey: monthKey, monthStart: monthStart,
    monthEnd: monthEnd, addMonthKey: addMonthKey
  };
});
