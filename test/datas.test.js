'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/ledger-engine.js');

test('C1: hojeISO usa a data local, não UTC (22h em Brasília não vira o dia seguinte)', () => {
  // 30/09/2026 22:30 no horário local do processo: toISOString() em UTC-3 daria 2026-10-01.
  const noite = new Date(2026, 8, 30, 22, 30, 0);
  assert.equal(E.hojeISO(noite), '2026-09-30');
  const madrugada = new Date(2026, 0, 1, 0, 5, 0);
  assert.equal(E.hojeISO(madrugada), '2026-01-01');
});

test('C1: localISO/addDays não deslocam o dia por fuso', () => {
  assert.equal(E.localISO(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31');
  assert.equal(E.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(E.addDays('2026-03-01', -1), '2026-02-28');
});

test('M7: hojeISO é recalculado a cada chamada', () => {
  assert.equal(E.hojeISO(new Date(2026, 8, 30, 23, 59)), '2026-09-30');
  assert.equal(E.hojeISO(new Date(2026, 9, 1, 0, 1)), '2026-10-01');
});

test('A5/B4: addMonths limita ao último dia do mês e preserva o dia original', () => {
  assert.equal(E.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(E.addMonths('2026-01-31', 1, 31), '2026-02-28');
  assert.equal(E.addMonths('2026-02-28', 1, 31), '2026-03-31');
  assert.equal(E.addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(E.addMonths('2026-11-30', 3, 30), '2027-02-28');
  assert.equal(E.addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(E.addMonths('2026-01-15', -2), '2025-11-15');
});

test('isValidISO rejeita datas inexistentes', () => {
  assert.equal(E.isValidISO('2026-02-30'), false);
  assert.equal(E.isValidISO('2026-13-01'), false);
  assert.equal(E.isValidISO('2026-02-28'), true);
  assert.equal(E.isValidISO('26-02-28'), false);
  assert.equal(E.isValidISO(null), false);
});

test('monthKey / monthEnd / addMonthKey', () => {
  assert.equal(E.monthKey('2026-09-30'), '2026-09');
  assert.equal(E.monthEnd('2026-02'), '2026-02-28');
  assert.equal(E.addMonthKey('2026-11', 3), '2027-02');
});
