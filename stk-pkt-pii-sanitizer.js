/**
 * @file stk-pkt-pii-sanitizer.js
 * @description Motor de Anonimização e Redação de Dados Pessoais Sensíveis (PII).
 * Garante conformidade estrita com o Art. 11 da LGPD e os princípios Zero-Knowledge.
 * Impede o vazamento de identificadores em logs, traces e relatórios.
 * @version 1.0.0
 * @license GNU GPL v3
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SystekPiiSanitizer = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CPF_REGEX = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
  const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  const CARD_REGEX = /\b(?:\d{4}[ -]?){3}\d{4}\b/g;
  const SECRET_KEY_PARAM_REGEX = /(?:key|token|secret|senha|pin|password|auth)=([a-zA-Z0-9_\-]+)/gi;
  const BEARER_AUTH_REGEX = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g;

  /**
   * Sanitiza uma string única, substituindo PII por marcadores canônicos.
   * @param {string} input Texto original
   * @returns {string} Texto higienizado
   */
  function sanitizeString(input) {
    if (typeof input !== 'string') return input;
    return input
      .replace(CPF_REGEX, '[CPF_OCULTADO]')
      .replace(EMAIL_REGEX, '[EMAIL_OCULTADO]')
      .replace(CARD_REGEX, '[CARTAO_OCULTADO]')
      .replace(BEARER_AUTH_REGEX, 'Bearer [TOKEN_REDACTED]')
      .replace(SECRET_KEY_PARAM_REGEX, '$1=[REDACTED]');
  }

  /**
   * Higieniza profundamente um objeto, array ou estrutura de dados recursiva.
   * Não altera o objeto original (imutabilidade).
   * @param {*} target Alvo a higienizar
   * @returns {*} Cópia segura sem PII
   */
  function sanitize(target) {
    if (target === null || target === undefined) return target;
    if (typeof target === 'string') return sanitizeString(target);
    if (typeof target === 'number' || typeof target === 'boolean') return target;

    if (Array.isArray(target)) {
      return target.map(item => sanitize(item));
    }

    if (target instanceof Error) {
      return {
        name: target.name,
        message: sanitizeString(target.message),
        stack: sanitizeString(target.stack || '')
      };
    }

    if (typeof target === 'object') {
      const sanitizedObj = {};
      for (const [key, val] of Object.entries(target)) {
        // Redação preventiva por nome da chave
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes('senha') || lowerKey.includes('password') || lowerKey.includes('pin') || lowerKey.includes('secret')) {
          sanitizedObj[key] = '[CONFIDENCIAL_REDACTED]';
        } else {
          sanitizedObj[key] = sanitize(val);
        }
      }
      return sanitizedObj;
    }

    return target;
  }

  return {
    sanitizeString,
    sanitize,
    patterns: {
      CPF_REGEX,
      EMAIL_REGEX,
      CARD_REGEX
    }
  };
});
