/**
 * @file stk-pkt-audit-trail.js
 * @description Trilha de Auditoria Criptográfica Encadeada (Append-Only SHA-256 Ledger).
 * Garante a integridade matemática e não-repúdio de registros locais em repouso.
 * Zero dependências externas; utiliza Web Crypto API nativa.
 * @version 1.0.0
 * @license GNU GPL v3
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SystekAuditTrail = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GENESIS_PREV_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

  /**
   * Computa o hash SHA-256 de uma string via Web Crypto API nativa.
   * @param {string} dataStr
   * @returns {Promise<string>} Hexadecimal em minúsculas de 64 caracteres.
   */
  async function computeSha256(dataStr) {
    const enc = new TextEncoder();
    const buffer = enc.encode(dataStr);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Constrói a string canônica para cálculo do hash do bloco.
   * @param {number} index
   * @param {string} timestamp
   * @param {string} eventType
   * @param {object} payload
   * @param {string} previousHash
   * @returns {string}
   */
  function formatCanonicalBlockString(index, timestamp, eventType, payload, previousHash) {
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return `${index}|${timestamp}|${eventType}|${payloadStr}|${previousHash}`;
  }

  class AuditLedger {
    /**
     * @param {object} storageAdapter Objeto com getItem(key) e setItem(key, value)
     * @param {string} ledgerKey Identificador único do livro razão no storage
     */
    constructor(storageAdapter, ledgerKey = 'stk_audit_ledger_v1') {
      if (!storageAdapter) {
        throw new Error('AuditLedger requer um storageAdapter válido.');
      }
      this.storage = storageAdapter;
      this.ledgerKey = ledgerKey;
    }

    /**
     * Recupera a cadeia completa de blocos do storage.
     * @returns {Promise<Array<object>>}
     */
    async getChain() {
      try {
        const raw = await this.storage.getItem(this.ledgerKey);
        if (!raw) return [];
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        console.error('Falha ao ler ledger de auditoria:', err);
        return [];
      }
    }

    /**
     * Grava um novo evento na trilha de auditoria encadeada.
     * @param {string} eventType Tipo do evento (ex: 'WORKOUT_RECORDED', 'FINANCE_TRANSACTION')
     * @param {object} payload Dados associados ao evento
     * @returns {Promise<object>} O bloco de auditoria gerado e selado
     */
    async appendEvent(eventType, payload) {
      if (!eventType || typeof eventType !== 'string') {
        throw new Error('eventType deve ser uma string não-vazia.');
      }

      const chain = await this.getChain();
      const index = chain.length;
      const timestamp = new Date().toISOString();
      const previousHash = index === 0 ? GENESIS_PREV_HASH : chain[index - 1].currentHash;

      const canonicalString = formatCanonicalBlockString(index, timestamp, eventType, payload, previousHash);
      const currentHash = await computeSha256(canonicalString);

      const block = {
        index,
        timestamp,
        eventType,
        payload: JSON.parse(JSON.stringify(payload || {})),
        previousHash,
        currentHash
      };

      chain.push(block);
      await this.storage.setItem(this.ledgerKey, JSON.stringify(chain));
      return block;
    }

    /**
     * Valida matematicamente a integridade de todos os elos da cadeia.
     * Detecta adulterações no payload, nos timestamps, nos índices ou no encadeamento de hashes.
     * @returns {Promise<{valid: boolean, blocksCount: number, error?: string, corruptedIndex?: number}>}
     */
    async verifyIntegrity() {
      const chain = await this.getChain();
      if (chain.length === 0) {
        return { valid: true, blocksCount: 0 };
      }

      for (let i = 0; i < chain.length; i++) {
        const block = chain[i];
        const expectedPrevHash = i === 0 ? GENESIS_PREV_HASH : chain[i - 1].currentHash;

        // 1. Validação de encadeamento do bloco anterior
        if (block.previousHash !== expectedPrevHash) {
          return {
            valid: false,
            blocksCount: chain.length,
            corruptedIndex: i,
            error: `Elo quebrado no bloco ${i}: previousHash esperado ${expectedPrevHash.slice(0, 8)}, obtido ${block.previousHash?.slice(0, 8)}`
          };
        }

        // 2. Validação de hash do conteúdo do bloco
        const canonicalString = formatCanonicalBlockString(
          block.index,
          block.timestamp,
          block.eventType,
          block.payload,
          block.previousHash
        );
        const expectedHash = await computeSha256(canonicalString);

        if (block.currentHash !== expectedHash) {
          return {
            valid: false,
            blocksCount: chain.length,
            corruptedIndex: i,
            error: `Adulteração detectada no bloco ${i}: hash esperado ${expectedHash.slice(0, 8)}, obtido ${block.currentHash?.slice(0, 8)}`
          };
        }
      }

      return { valid: true, blocksCount: chain.length };
    }
  }

  return {
    AuditLedger,
    computeSha256,
    GENESIS_PREV_HASH
  };
});
