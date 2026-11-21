/**
 * stk-pkt-security-certificate.js
 * Módulo Canônico de Emissão de Certificado de Segurança, Recuperação por 12 Palavras BIP39 e Termos de Privacidade LGPD
 * Systekna Core Security Framework - Padrão Zero-Knowledge Local-First
 * 
 * Funcionalidades:
 * 1. Emissão de PDF de Alta Fidelidade (%PDF-1.4) 100% Client-Side sem bibliotecas pesadas externas.
 * 2. Visualização das 12 palavras BIP39 (pt-BR) e Código Hash SHA-256 de recuperação de cofre.
 * 3. Instruções de Segurança Física e Diretrizes de Privacidade e Anonimização (Art. 11 LGPD).
 * 4. Modal responsivo de Política de Privacidade e Confidencialidade Local-First.
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SystekSecurityCertificate = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WIN_ANSI = {
    '•': 0x95, '–': 0x96, '—': 0x97, '“': 0x93, '”': 0x94, '‘': 0x91, '’': 0x92,
    'á': 0xE1, 'à': 0xE0, 'â': 0xE2, 'ã': 0xE3, 'é': 0xE9, 'ê': 0xEA, 'í': 0xED,
    'ó': 0xF3, 'ô': 0xF4, 'õ': 0xF5, 'ú': 0xFA, 'ç': 0xE7, 'Á': 0xC1, 'À': 0xC0,
    'Â': 0xC2, 'Ã': 0xC3, 'É': 0xC9, 'Ê': 0xCA, 'Í': 0xCD, 'Ó': 0xD3, 'Ô': 0xD4,
    'Õ': 0xD5, 'Ú': 0xDA, 'Ç': 0xC7
  };

  function sanitizePdfText(text) {
    return '(' + Array.from(String(text || ''), ch => {
      const code = WIN_ANSI[ch] || ch.charCodeAt(0);
      if (ch === '(' || ch === ')' || ch === '\\') return '\\' + ch;
      if (code >= 32 && code < 127) return ch;
      if (code <= 255) return '\\' + code.toString(8).padStart(3, '0');
      return '?';
    }).join('') + ')';
  }

  /**
   * Constrói o fluxo PDF puro (%PDF-1.4) com layout canônico de certificado de segurança A4
   */
  function buildCertificatePdfRaw({
    appName = 'Systekna App',
    words = [],
    hash = 'XXXX-XXXX-XXXX',
    issuedAt = new Date().toLocaleDateString('pt-BR'),
    appSubtitle = 'Sistema Local-First com Criptografia de Ponta a Ponta',
    securityLevel = 'AES-GCM-256 · PBKDF2-600k · Zero-Knowledge'
  } = {}) {
    const out = [];
    const line = (font, size, x, y, text) => {
      out.push(`BT /${font} ${size} Tf ${x} ${y} Td ${sanitizePdfText(text)} Tj ET`);
    };

    // Moldura decorativa externa (A4: 595 x 842 pt)
    out.push('0.2 G 1.5 w 30 30 535 782 re S');
    out.push('0.6 G 0.5 w 34 34 527 774 re S');

    // Cabeçalho institucional
    line('F2', 20, 50, 780, `${appName.toUpperCase()} – CERTIFICADO DE SEGURANÇA`);
    line('F1', 10, 50, 762, `${appSubtitle} · Padrão Zero-Knowledge`);
    line('F1', 9, 50, 748, `Nível Criptográfico: ${securityLevel}`);
    line('F1', 9, 50, 736, `Data e Hora de Emissão: ${issuedAt} · Chave Local no Aparelho`);

    // Linha divisória
    out.push('0.4 G 1 w 50 722 495 0 re S');

    // Seção das 12 Palavras Mnemônicas
    line('F2', 13, 50, 702, '1. SUAS 12 PALAVRAS DE RECUPERAÇÃO DO COFRE (PADRÃO BIP39)');
    line('F1', 9.5, 50, 688, 'Estas 12 palavras em português formam a chave-mestra física para recuperar seu PIN e abrir seus backups:');

    // Caixa das 12 palavras
    out.push('0.92 g 50 515 495 160 re f');
    out.push('0.4 G 1 w 50 515 495 160 re S');

    // Grid 3 colunas x 4 linhas
    const wordsList = Array.isArray(words) ? words : String(words).split(/\s+/).filter(Boolean);
    wordsList.slice(0, 12).forEach((w, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 70 + col * 160;
      const y = 642 - row * 36;
      const numStr = (i + 1 < 10 ? '0' : '') + (i + 1) + '. ';
      line('F3', 13, x, y, `${numStr}${w}`);
    });

    // Seção do Hash de Validação
    line('F2', 13, 50, 485, '2. CÓDIGO HASH DE VALIDAÇÃO (12 CARACTERES)');
    line('F1', 9.5, 50, 471, 'Identificador unívoco derivado da raiz criptográfica (pode ser usado como alternativa às palavras):');

    out.push('0.95 g 50 425 495 38 re f');
    out.push('0.3 G 1 w 50 425 495 38 re S');
    line('F3', 20, 185, 437, String(hash).toUpperCase());

    // Seção de Instruções Críticas de Segurança Física
    line('F2', 13, 50, 395, '3. DIRETRIZES FUNDAMENTAIS DE SEGURANÇA E PRIVACIDADE');
    const guidelines = [
      '• Privacidade Absoluta: Nenhum dado seu é transmitido a servidores ou terceiros (Art. 11 LGPD).',
      '• Chave Exclusiva: Se você esquecer seu PIN e perder este documento, os dados não poderão ser recuperados.',
      '• Nunca Fotografe ou Envie por Mensagem: Quem tiver acesso a este papel pode redefinir o PIN dos seus apps.',
      '• Impressão Física Recomendada: Imprima esta folha e guarde em cofre ou local seguro fora do alcance de curiosos.',
      '• Descarte Seguro: Após a impressão em papel, APAGUE o arquivo PDF gerado da memória do aparelho.',
      '• Proteção contra Olhares Curiosos: O bloqueio de tela por PIN protege o aplicativo contra acessos não autorizados.'
    ];

    guidelines.forEach((g, idx) => {
      line('F1', 9.5, 50, 370 - idx * 20, g);
    });

    // Rodapé de Autenticidade
    out.push('0.7 G 0.5 w 50 220 495 0 re S');
    line('F2', 10, 50, 204, 'Systekna Architecture Core · Zero-Knowledge Cryptographic Baseline');
    line('F1', 8.5, 50, 190, 'Este certificado foi sintetizado inteiramente em memória no dispositivo cliente.');
    line('F1', 8.5, 50, 178, 'Documento autônomo e auto-verificável · Sem conexão externa requerida.');

    const stream = out.join('\n');
    const streamLen = typeof Buffer !== 'undefined' ? Buffer.byteLength(stream, 'binary') : stream.length;

    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>',
      `<< /Length ${streamLen} >>\nstream\n${stream}\nendstream`
    ];

    let pdf = '%PDF-1.4\n';
    const offsets = [];
    objs.forEach((body, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });

    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
      + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
      + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

    return pdf;
  }

  /**
   * Converte a string PDF para Blob (navegador) ou Buffer (Node.js)
   */
  function generateCertificatePdfBlob(options) {
    const rawPdf = buildCertificatePdfRaw(options);
    if (typeof Blob !== 'undefined') {
      return new Blob([rawPdf], { type: 'application/pdf' });
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(rawPdf, 'binary');
    }
    return rawPdf;
  }

  /**
   * Dispara o download automático do PDF de certificado no navegador
   */
  function downloadCertificatePdf(options = {}) {
    if (typeof document === 'undefined' || typeof URL === 'undefined') {
      throw new Error('downloadCertificatePdf só pode ser executado no contexto do navegador.');
    }
    const blob = generateCertificatePdfBlob(options);
    const fileName = `certificado-seguranca-${(options.appName || 'systekna').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /**
   * Renderiza a declaração formal de Privacidade e Segurança (Art. 11 e Art. 18 LGPD)
   */
  function getPrivacyPolicyContent(appName = 'Systekna') {
    return {
      title: `Privacidade e Proteção de Dados · ${appName}`,
      summary: 'Arquitetura Zero-Knowledge Local-First: seus dados pertencem exclusivamente a você e nunca saem do seu aparelho.',
      sections: [
        {
          heading: '1. Armazenamento 100% Local (Local-First)',
          text: 'Todas as suas informações (cadastros, treinos, saúde, diários, cálculos, finanças ou metas) são persistidas estritamente na memória e bancos de dados locais do seu próprio navegador (IndexedDB e LocalStorage). Nenhum dado pessoal é transmitido para servidores remotos da Systekna ou de terceiros.'
        },
        {
          heading: '2. Criptografia Forte e Cofre Local',
          text: 'Os dados sensíveis são protegidos por criptografia de padrão militar (AES-GCM 256 bits derivada via PBKDF2 com 600.000 iterações). O cofre possui autodestruição em memória (Zeroization) para impedir vazamento de chaves na heap do dispositivo.'
        },
        {
          heading: '3. Bloqueio por PIN contra Olhares Curiosos',
          text: 'O aplicativo disponibiliza bloqueio com PIN numérico tátil de acesso imediato. O PIN previne que terceiros manuseando o seu aparelho tenham acesso visual às suas informações. O sistema inclui proteção contra força-bruta (PinGuard).'
        },
        {
          heading: '4. Recuperação Soberana por 12 Palavras (BIP39)',
          text: 'Como não temos acesso aos seus dados nem guardamos senhas em servidores (Zero-Knowledge), a recuperação de acesso caso você esqueça o PIN é feita unicamente através das suas 12 palavras-chave mnemônicas ou do seu código Hash de 12 caracteres contidos no seu Certificado de Segurança.'
        },
        {
          heading: '5. Direitos do Titular (Art. 18 LGPD)',
          text: 'Você tem controle soberano absoluto: a qualquer momento é possível exportar um arquivo de backup completo dos seus registros ou realizar a exclusão irreversível de todos os dados locais com duplo clique de confirmação nas Configurações.'
        }
      ]
    };
  }

  return {
    buildCertificatePdfRaw,
    generateCertificatePdfBlob,
    downloadCertificatePdf,
    getPrivacyPolicyContent
  };
});
