(async function(){
  "use strict";
  await window.vaultReady;
  const localStorage = window.secureStorage;
  const STATE_KEY = "livro_caixa_state_v2";

  var STORAGE_KEY = "livro_caixa_v1";
  var SECURITY_META_KEY = "livro_caixa_security_v1";
  var SECURITY_DATA_KEY = "livro_caixa_secure_data_v1";
  var SECURITY_RECOVERY_KEY = "livro_caixa_recovery_data_v1";
  var DEVICE_CERT_KEY = "livro_caixa_device_cert_v1";
  var Engine = window.LedgerEngine;
  // Data local recalculada a cada uso (C1, M7): nunca congelada na abertura e nunca em UTC.
  function hoje(){ return Engine.hojeISO(); }

  var state = Engine.freshState();

  function uid(){ return Engine.uid(); }
  // Todos os valores do estado são centavos inteiros; só formatamos na exibição (A6).
  function fmt(cents){ return Engine.fmtBRL(cents); }

  function b64(bytes){ var s=''; for(var i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]); return btoa(s); }
  function fromB64(s){ var raw=atob(s), out=new Uint8Array(raw.length); for(var i=0;i<raw.length;i++) out[i]=raw.charCodeAt(i); return out; }
  function freshState(){ return Engine.freshState(); }
  function normalizeState(parsed){ state = Engine.normalizeState(parsed); }
  // Com o PIN FINANC, o certificado é o FINANC (um só para todos os apps; o kit já trouxe o antigo deste app).
  // Sem ele (app ainda com PIN próprio), segue o certificado próprio guardado no cofre do app.
  var FinancCert = window.FinancCert;
  function certFor(id){
    if (FinancCert.linked) return (id && FinancCert.find(id)) || FinancCert.current;
    try { var raw=localStorage.getItem(DEVICE_CERT_KEY); return raw ? JSON.parse(raw) : null; } catch(e) { return null; }
  }
  async function saveCert(cert){
    if (FinancCert.linked) { await FinancCert.add(cert); return; }
    localStorage.setItem(DEVICE_CERT_KEY,JSON.stringify(cert)); await localStorage.flush();
  }
  function getDeviceCert(){
    try { var raw=localStorage.getItem(DEVICE_CERT_KEY); if (raw) return JSON.parse(raw); } catch(e) {}
    var bytes=crypto.getRandomValues(new Uint8Array(32));
    var cert={version:1,id:'cert-'+b64(crypto.getRandomValues(new Uint8Array(12))).replace(/[^a-zA-Z0-9]/g,'').slice(0,16),secret:b64(bytes),createdAt:new Date().toISOString()};
    localStorage.setItem(DEVICE_CERT_KEY,JSON.stringify(cert));
    return cert;
  }
  function combinedSecret(pin, cert){ return pin + '::GERENC-FIN-CERT::' + (cert ? cert.secret : ''); }
  async function deriveKey(pin, salt, cert){
    var material = await crypto.subtle.importKey('raw', new TextEncoder().encode(cert ? combinedSecret(pin,cert) : pin), {name:'PBKDF2'}, false, ['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2', salt:salt, iterations:150000, hash:'SHA-256'}, material, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
  }
  async function seal(value, key){
    var iv=crypto.getRandomValues(new Uint8Array(12));
    var data=new TextEncoder().encode(JSON.stringify(value));
    var ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:iv}, key, data);
    return {iv:b64(iv), ciphertext:b64(new Uint8Array(ciphertext))};
  }
  async function unseal(payload, key){
    var plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64(payload.iv)}, key, fromB64(payload.ciphertext));
    return JSON.parse(new TextDecoder().decode(plain));
  }
  document.getElementById('gateRecover').addEventListener('click',function(){ document.getElementById('btnRecover').click(); });
  document.getElementById('gateImportCert').addEventListener('click',function(){ document.getElementById('gateCertFile').click(); });
  document.getElementById('gateCertFile').addEventListener('change',function(e){
    var file=e.target.files[0]; if(!file) return;
    var reader=new FileReader(); reader.onload=async function(ev){
      try { var cert=await window.importCertificate(JSON.parse(ev.target.result), 'gerenc-fin:certificate'); if(!cert || !cert.id || !cert.secret) throw new Error();
        await saveCert(cert); document.getElementById('gateStatus').textContent='Certificado importado. Recarregando…'; setTimeout(function(){ location.reload(); },300);
      } catch(err) { document.getElementById('gateStatus').textContent='Arquivo de certificado inválido.'; }
    }; reader.readAsText(file); e.target.value='';
  });

  async function load(){
    const current = localStorage.getItem(STATE_KEY);
    if (current) normalizeState(JSON.parse(current));
    else {
      const metaRaw = localStorage.getItem(SECURITY_META_KEY);
      const secureRaw = localStorage.getItem(SECURITY_DATA_KEY);
      if (metaRaw && secureRaw) {
        const meta = JSON.parse(metaRaw);
        const pin = await window.askSecret('Digite o PIN ou senha anterior para migrar o livro-caixa. Cancele para usar a recuperação antiga:', false, true);
        if (pin) {
          const cert = certFor(meta.certId);
          if (meta.certProtected && (!cert || meta.certId !== cert.id)) throw new Error('Importe o certificado antigo antes de migrar os dados.');
          const key = await deriveKey(pin, fromB64(meta.salt), meta.certProtected ? cert : null);
          await unseal(meta.verifier, key);
          normalizeState(await unseal(JSON.parse(secureRaw), key));
        } else {
          const code = await window.askSecret('Digite a frase de recuperação antiga:', false, true);
          if (!code) throw new Error('Migração cancelada. Os dados antigos foram preservados.');
          const key = await deriveKey(code.trim().replace(/\s+/g,' '), fromB64(meta.recoverySalt));
          await unseal(meta.recoveryVerifier, key);
          normalizeState(await unseal(JSON.parse(localStorage.getItem(SECURITY_RECOVERY_KEY)), key));
        }
      } else {
        const legacy = localStorage.getItem(STORAGE_KEY);
        normalizeState(legacy ? JSON.parse(legacy) : null);
      }
      await save();
    }
    // Retire legacy credentials only after the migrated state has been saved.
    [STORAGE_KEY, SECURITY_META_KEY, SECURITY_DATA_KEY, SECURITY_RECOVERY_KEY,
      'livro_caixa_session_unlocked_v1', 'livro_caixa_session_last_activity_v1'].forEach(key => localStorage.removeItem(key));
    await localStorage.flush();
    document.body.classList.remove('locked');
  }
  var saveTimer = null;
  async function save(){
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    await localStorage.flush();
    const el = document.getElementById('saveStatus');
    el.textContent = 'salvo e criptografado neste navegador';
  }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // ---------- diálogos (mesmo padrão modal do app: <dialog class="vault-dialog">) ----------
  function iconSvg(name, size){ return window.FinancIcons ? window.FinancIcons.svg(name, {size:size}) : ''; }
  function dialogBox(build){
    return new Promise(function(resolve){
      var dialog = document.createElement('dialog'); dialog.className = 'vault-dialog';
      var result = null;
      build(dialog, function(value){ result = value; dialog.close(); });
      dialog.onclose = function(){ dialog.remove(); resolve(result); };
      document.body.append(dialog); dialog.showModal();
    });
  }
  function dialogHead(title, text, iconName, danger){
    var head = document.createElement('div'); head.className = 'vault-dialog-head';
    head.innerHTML = '<span class="vault-badge' + (danger ? ' vault-badge-danger' : '') + '">' + iconSvg(iconName || 'info', 18) + '</span>';
    var p = document.createElement('p'); var b = document.createElement('b'); b.textContent = title; p.append(b); head.append(p);
    var frag = [head];
    if (text) { var t = document.createElement('p'); t.className = 'vault-dim'; t.textContent = text; frag.push(t); }
    return frag;
  }
  function askConfirm(o){
    return dialogBox(function(dialog, close){
      var actions = document.createElement('div'); actions.className = 'vault-dialog-actions';
      var no = document.createElement('button'); no.type = 'button'; no.textContent = o.cancel || 'Cancelar'; no.onclick = function(){ close(false); };
      var yes = document.createElement('button'); yes.type = 'button'; yes.textContent = o.action || 'Confirmar';
      yes.className = o.danger ? 'vault-dialog-danger' : 'vault-dialog-primary'; yes.onclick = function(){ close(true); };
      actions.append(no, yes);
      dialog.append.apply(dialog, dialogHead(o.title, o.text, o.danger ? 'alert' : 'info', o.danger).concat([actions]));
    }).then(function(v){ return v === true; });
  }
  function showMessage(title, text, danger){
    return dialogBox(function(dialog, close){
      var actions = document.createElement('div'); actions.className = 'vault-dialog-actions';
      var ok = document.createElement('button'); ok.type = 'button'; ok.className = 'vault-dialog-primary'; ok.textContent = 'Entendi'; ok.onclick = function(){ close(true); };
      actions.append(ok);
      dialog.append.apply(dialog, dialogHead(title, text, danger === false ? 'info' : 'alert', danger !== false).concat([actions]));
    });
  }
  /** Modal de baixa: data, valor efetivamente pago (e conta, se houver mais de uma). Resolve {data, valorPago, contaId} ou null. */
  function askPayment(o){
    return dialogBox(function(dialog, close){
      var form = document.createElement('form'); form.method = 'dialog'; form.className = 'pay-form';
      var contas = state.contas.length > 1 ? '<label>Conta<select name="conta">' + state.contas.map(function(c){ return '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.nome) + '</option>'; }).join('') + '</select></label>' : '';
      form.innerHTML = '<label>Data do pagamento<input type="date" name="data" required max="' + hoje() + '" value="' + hoje() + '"></label>' +
        '<label>Valor pago (R$)<input type="number" name="valor" step="0.01" min="0.01" max="999999999.99" required value="' + Engine.centsToInput(o.valor) + '"></label>' + contas +
        '<p class="vault-dim pay-diff" aria-live="polite"></p>';
      var diff = form.querySelector('.pay-diff'), inValor = form.elements.valor;
      var update = function(){
        var c = Engine.parseCents(inValor.value); var d = c === null ? 0 : c - o.valor;
        diff.textContent = d > 0 ? 'Diferença de ' + fmt(d) + ' será registrada como juros/multa.' : d < 0 ? 'Diferença de ' + fmt(-d) + ' será registrada como desconto.' : '';
      };
      inValor.addEventListener('input', update);
      var actions = document.createElement('div'); actions.className = 'vault-dialog-actions';
      var no = document.createElement('button'); no.type = 'button'; no.textContent = 'Cancelar'; no.onclick = function(){ close(null); };
      var yes = document.createElement('button'); yes.type = 'submit'; yes.textContent = o.action || 'Confirmar pagamento';
      actions.append(no, yes); form.append(actions);
      form.onsubmit = function(ev){
        ev.preventDefault();
        var c = Engine.parseCents(inValor.value);
        if (!(c > 0) || c > Engine.MAX_CENTS) { inValor.setCustomValidity('Informe um valor válido.'); inValor.reportValidity(); return; }
        close({ data: form.elements.data.value, valorPago: c, contaId: form.elements.conta ? form.elements.conta.value : undefined });
      };
      inValor.addEventListener('input', function(){ inValor.setCustomValidity(''); });
      dialog.append.apply(dialog, dialogHead(o.title, o.text, 'check').concat([form]));
      update();
    });
  }

  // ---------- render helpers ----------
  function dueTag(venc, pago){
    if (pago) return '<span class="tag paid">pago</span>';
    if (!venc) return '';
    var h = hoje();
    if (venc < h) return '<span class="tag overdue">atrasado</span>';
    if (venc <= Engine.addDays(h, 7)) return '<span class="tag due-soon">vence em breve</span>';
    return '';
  }

  function dateBR(iso){
    if(!iso) return '';
    var p = iso.split('-');
    return p[2]+'/'+p[1]+'/'+p[0];
  }

  function rowHtml(opts){
    // opts: {title, meta, amt, amtClass, paid, actions: [{label,cls,action}]}
    var actionsHtml = opts.actions.map(function(a){
      return '<button class="'+a.cls+'" data-action="'+a.action+'">'+a.label+'</button>';
    }).join('');
    return '<div class="row'+(opts.paid?' paid':'')+'" data-id="'+escapeHtml(opts.id)+'">'+
      '<div class="desc"><div class="t">'+opts.title+'</div><div class="meta">'+opts.meta+'</div></div>'+
      '<div class="amt '+opts.amtClass+' num">'+opts.amt+'</div>'+
      '<div class="actions">'+actionsHtml+'</div>'+
    '</div>';
  }

  function renderDespesas(){
    var abertas = state.expenses.filter(function(x){return !x.pago;}).sort(function(a,b){return a.vencimento.localeCompare(b.vencimento);});
    var pagas = state.expenses.filter(function(x){return x.pago;}).sort(function(a,b){return (b.dataPagamento||'').localeCompare(a.dataPagamento||'');});

    document.getElementById('listDespesasAbertas').innerHTML = abertas.length ? abertas.map(function(x){
      return rowHtml({
        id: x.id,
        title: escapeHtml(x.descricao) + dueTag(x.vencimento, false),
        meta: 'vence em ' + dateBR(x.vencimento) + (x.origem && x.origem.tipo === 'fatura' ? ' · fatura do cartão' : ''),
        amt: fmt(x.valor),
        amtClass: 'neg',
        paid: false,
        actions: [
          {label:'pagar', cls:'pay', action:'pay-expense'},
          {label:'excluir', cls:'del', action:'del-expense'}
        ]
      });
    }).join('') : '<div class="empty">nenhuma despesa em aberto.</div>';

    document.getElementById('listDespesasPagas').innerHTML = pagas.length ? pagas.map(function(x){
      var aj = Engine.expenseAjuste(x);
      var ajTxt = aj > 0 ? ' · pago ' + fmt(x.valorPago) + ' (juros/multa ' + fmt(aj) + ')' : aj < 0 ? ' · pago ' + fmt(x.valorPago) + ' (desconto ' + fmt(-aj) + ')' : '';
      return rowHtml({
        id: x.id,
        title: escapeHtml(x.descricao),
        meta: 'pago em ' + dateBR(x.dataPagamento) + ajTxt,
        amt: fmt(x.valor),
        amtClass: '',
        paid: true,
        actions: [{label:'estornar', cls:'', action:'unpay-expense'}, {label:'excluir', cls:'del', action:'del-expense'}]
      });
    }).join('') : '<div class="empty">nenhuma despesa paga ainda.</div>';
  }

  function renderEntradas(){
    var list = state.income.slice().sort(function(a,b){return b.data.localeCompare(a.data);});
    document.getElementById('listEntradas').innerHTML = list.length ? list.map(function(x){
      return rowHtml({
        id: x.id,
        title: escapeHtml(x.descricao),
        meta: dateBR(x.data),
        amt: fmt(x.valor),
        amtClass: 'pos',
        paid: false,
        actions: [{label:'excluir', cls:'del', action:'del-income'}]
      });
    }).join('') : '<div class="empty">nenhuma entrada lançada.</div>';
  }

  function renderCartao(){
    var c = state.card;
    document.getElementById('cLimite').value = c.limite ? Engine.centsToInput(c.limite) : '';
    document.getElementById('cFechamento').value = c.fechamento || '';
    document.getElementById('cVencimento').value = c.vencimentoDia || '';

    var usado = Engine.cardUsed(state);
    var limite = c.limite;
    var pct = limite > 0 ? Math.min(100, (usado/limite)*100) : 0;
    var disponivel = Engine.cardAvailable(state);

    document.getElementById('cartaoUsadoLabel').textContent = fmt(usado);
    document.getElementById('cartaoLimiteLabel').textContent = fmt(limite);
    document.getElementById('cartaoFill').style.width = pct + '%';
    document.getElementById('sumCartao').textContent = fmt(disponivel);

    var bar = document.getElementById('limiteBar');
    bar.classList.remove('warn','danger');
    if (pct >= 90) bar.classList.add('danger');
    else if (pct >= 70) bar.classList.add('warn');

    document.getElementById('cartaoConfigInfo').innerHTML =
      'fecha todo dia <b>' + (c.fechamento||'-') + '</b> &nbsp;·&nbsp; vence dia <b>' + (c.vencimentoDia||'-') + '</b> &nbsp;·&nbsp; disponível <b>' + fmt(disponivel) + '</b>' +
      '<span>em aberto <b>' + fmt(Math.max(0, Engine.cardOpenTotal(state))) + '</b> &nbsp;·&nbsp; faturas a pagar <b>' + fmt(Engine.cardInvoicesUnpaid(state)) + '</b></span>';

    var h = hoje();
    var ciclos = Engine.openCycles(state);
    document.getElementById('listCartaoAberto').innerHTML = ciclos.length ? ciclos.map(function(cy){
      var podeFechar = cy.fechamento <= h;
      var head = rowHtml({
        id: cy.fechamento,
        title: (podeFechar ? 'fatura fechada em ' : 'fatura que fecha em ') + dateBR(cy.fechamento),
        meta: 'vence em ' + dateBR(cy.vencimento) + ' · ' + cy.itens.length + ' lançamento(s)' + (podeFechar ? '' : ' · ainda aberta'),
        amt: fmt(Math.max(0, cy.total)),
        amtClass: 'neg',
        paid: false,
        actions: podeFechar ? [{label:'gerar despesa da fatura', cls:'pay', action:'close-invoice'}] : []
      }).replace('class="row"', 'class="row cycle"');
      var itens = cy.itens.slice().sort(function(a,b){return b.data.localeCompare(a.data);}).map(function(x){
        var cred = x.tipo === 'credito';
        return rowHtml({
          id: x.id,
          title: escapeHtml(x.descricao) + (x.parcelas > 1 ? ' · parcela ' + x.parcelaAtual + '/' + x.parcelas : '') + (cred ? ' <span class="tag paid">crédito</span>' : ''),
          meta: dateBR(x.data),
          amt: (cred ? '− ' : '') + fmt(x.valor),
          amtClass: cred ? 'pos' : 'neg',
          paid: false,
          actions: [{label:'excluir', cls:'del', action:'del-card-item'}]
        }).replace('class="row"', 'class="row item"');
      }).join('');
      return head + itens;
    }).join('') : '<div class="empty">nenhum lançamento em aberto no cartão.</div>';

    var faturas = c.faturas.slice().sort(function(a,b){return b.dataFechamento.localeCompare(a.dataFechamento);});
    document.getElementById('listFaturas').innerHTML = faturas.length ? faturas.map(function(f){
      var despesa = Engine.faturaDespesa(state, f);
      var pago = despesa ? despesa.pago : true;
      var acts = despesa && !despesa.pago ? [{label:'reabrir', cls:'', action:'reopen-invoice'}] : [];
      return rowHtml({
        id: f.id,
        title: 'fatura fechada em ' + dateBR(f.dataFechamento) + (!despesa ? ' <span class="tag paid">sem valor a pagar</span>' : pago ? ' <span class="tag paid">paga</span>' : ' <span class="tag due-soon">a pagar</span>'),
        meta: despesa ? ('lançada em Despesas · vence ' + dateBR(despesa.vencimento)) : 'sem despesa vinculada',
        amt: fmt(f.total),
        amtClass: pago ? '' : 'neg',
        paid: pago,
        actions: acts
      });
    }).join('') : '<div class="empty">nenhuma fatura fechada ainda.</div>';
  }

  function renderDividas(){
    var abertas = state.debts.filter(function(d){return !d.pago;}).sort(function(a,b){return a.vencimento.localeCompare(b.vencimento);});
    var quitadas = state.debts.filter(function(d){return d.pago;});
    var total = Engine.debtSaldoTotal(state);
    document.getElementById('dividasTotal').textContent = abertas.length ? 'saldo devedor total (nominal): ' + fmt(total) : '';

    document.getElementById('listDividasAbertas').innerHTML = abertas.length ? abertas.map(function(d){
      var extra = '';
      if (d.valorContratado) extra += ' · contratado ' + fmt(d.valorContratado);
      if (d.taxa !== null) extra += ' · taxa ' + String(d.taxa).replace('.', ',') + '% a.m.';
      var acts = [{label:'pagar parcela', cls:'pay', action:'pay-debt'}];
      if (d.pagas.length) acts.push({label:'desfazer', cls:'', action:'undo-debt'});
      acts.push({label:'excluir', cls:'del', action:'del-debt'});
      return rowHtml({
        id: d.id,
        title: escapeHtml(d.descricao) + ' · parcela ' + d.parcelaAtual + '/' + d.parcelas + dueTag(d.vencimento,false),
        meta: 'próximo vencimento ' + dateBR(d.vencimento) + ' · saldo devedor ' + fmt(Engine.debtSaldo(d)) + ' (' + Engine.debtRemainingCount(d) + ' parcela(s))' + extra,
        amt: fmt(d.valorParcela),
        amtClass: 'neg',
        paid: false,
        actions: acts
      });
    }).join('') : '<div class="empty">nenhuma dívida em aberto.</div>';

    document.getElementById('listDividasQuitadas').innerHTML = quitadas.length ? quitadas.map(function(d){
      return rowHtml({
        id: d.id,
        title: escapeHtml(d.descricao),
        meta: d.parcelas + ' parcela(s) quitada(s) · total nominal (parcelas × valor)',
        amt: fmt(d.valorParcela * d.parcelas),
        amtClass: '',
        paid: true,
        actions: [{label:'desfazer', cls:'', action:'undo-debt'}, {label:'excluir', cls:'del', action:'del-debt'}].filter(function(a){ return a.action !== 'undo-debt' || d.pagas.length; })
      });
    }).join('') : '<div class="empty">nenhuma dívida quitada ainda.</div>';
  }


  function setSaldoColor(el, cents){ el.style.color = cents < 0 ? 'var(--rust)' : 'var(--green)'; }
  function renderSummary(){
    var r = Engine.monthSummary(state, hoje());
    document.getElementById('sumEntradas').textContent = fmt(r.caixa.entradas);
    document.getElementById('sumDespesas').textContent = fmt(r.caixa.saidas);
    var saldoEl = document.getElementById('sumSaldo');
    saldoEl.textContent = fmt(r.caixa.resultado); setSaldoColor(saldoEl, r.caixa.resultado);
    document.getElementById('sumPrevEntradas').textContent = fmt(r.previsto.entradas);
    document.getElementById('sumPrevSaidas').textContent = fmt(r.previsto.saidas);
    var prevEl = document.getElementById('sumPrevResultado');
    prevEl.textContent = fmt(r.previsto.resultado); setSaldoColor(prevEl, r.previsto.resultado);
    document.getElementById('sumAtraso').textContent = fmt(r.atrasoAnterior.total);
    document.getElementById('sumAtrasoQtd').textContent = r.atrasoAnterior.qtd ? r.atrasoAnterior.qtd + ' item(ns)' : '';
    document.getElementById('sumDividas').textContent = fmt(Engine.debtSaldoTotal(state));
  }

  function contaOptions(){ return state.contas.map(function(c){ return '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.nome) + '</option>'; }).join(''); }
  function renderConta(){
    var h = hoje();
    var total = Engine.saldoAtual(state, h);
    var el = document.getElementById('sumSaldoConta');
    el.textContent = total === null ? '—' : fmt(total);
    if (total !== null) setSaldoColor(el, total); else el.style.color = '';
    document.getElementById('sumSaldoContaSub').textContent = total === null ? 'cadastre em Conta' : '';
    document.getElementById('eContaLabel').hidden = state.contas.length < 2;
    var sel = document.getElementById('eConta'); var prev = sel.value; sel.innerHTML = contaOptions(); if (prev) sel.value = prev;

    document.getElementById('listContas').innerHTML = state.contas.length ? state.contas.map(function(c){
      var saldo = Engine.saldoConta(state, c.id, h);
      return rowHtml({ id: c.id, title: escapeHtml(c.nome), meta: 'saldo inicial ' + fmt(c.saldoInicial) + ' em ' + dateBR(c.dataSaldoInicial),
        amt: fmt(saldo), amtClass: saldo < 0 ? 'neg' : 'pos', paid: false, actions: [{label:'excluir', cls:'del', action:'del-conta'}] });
    }).join('') : '<div class="empty">nenhuma conta cadastrada. Informe o saldo atual e a data para acompanhar o saldo real.</div>';

    document.getElementById('conciliacao').innerHTML = state.contas.length ? state.contas.map(function(c){
      var saved = state.reconciliacao[c.id], res = saved ? Engine.reconcile(state, c.id, saved.saldoBanco, h) : null, msg = '', cls = '';
      if (res) {
        cls = res.status === 'ok' ? 'ok' : res.status === 'pendentes' ? 'mid' : 'bad';
        msg = 'Banco ' + fmt(res.saldoBanco) + ' (informado em ' + dateBR(saved.data) + ') · app ' + fmt(res.saldoApp) + ' · diferença ' + fmt(res.diferenca) + '. ' +
          (res.status === 'ok' ? 'Saldos conferem.' : res.status === 'pendentes'
            ? 'A diferença é explicada por ' + res.pendentes.qtd + ' lançamento(s) ainda não conferido(s) (' + fmt(res.pendentes.liquido) + ').'
            : 'Sobra diferença de ' + fmt(res.diferencaConciliado) + ' que os lançamentos pendentes não explicam: confira os movimentos abaixo.');
      }
      return '<div class="rec-box" data-conta="' + escapeHtml(c.id) + '"><div class="t">' + escapeHtml(c.nome) + ' · saldo no app ' + fmt(Engine.saldoConta(state, c.id, h)) + '</div>' +
        '<form class="rec"><label>Saldo informado pelo banco (R$)<input type="number" step="0.01" min="-999999999.99" max="999999999.99" required name="banco" value="' + (saved ? Engine.centsToInput(saved.saldoBanco) : '') + '"></label><button type="submit">Comparar</button></form>' +
        (msg ? '<div class="rec-result ' + cls + '">' + escapeHtml(msg) + '</div>' : '') + '</div>';
    }).join('') : '<div class="empty">cadastre uma conta para conciliar.</div>';

    var movs = Engine.realizedMovements(state, h).slice(0, 80);
    document.getElementById('listMovimentos').innerHTML = movs.length ? movs.map(function(m){
      return rowHtml({ id: m.id, title: escapeHtml(m.descricao) + (m.conferido ? ' <span class="tag paid">conferido</span>' : ''),
        meta: (m.tipo === 'entrada' ? 'entrada em ' : 'saída em ') + dateBR(m.data), amt: fmt(Math.abs(m.valor)), amtClass: m.tipo === 'entrada' ? 'pos' : 'neg', paid: false,
        actions: [{label: m.conferido ? 'desmarcar' : 'conferir', cls: m.conferido ? '' : 'pay', action: 'conf-' + m.tipo}] });
    }).join('') : '<div class="empty">nenhum movimento realizado desde o saldo inicial.</div>';
  }

  function renderAll(){
    renderDespesas();
    renderEntradas();
    renderCartao();
    renderDividas();
    renderConta();
    renderSummary();
  }

  // ---------- ações no menu do perfil ----------
  var clickById = function(id){ return function(){ document.getElementById(id).click(); }; };
  FinancSettings.addSection({ title: 'Dados e backup', rows: [
    { icon: 'download', label: 'Exportar backup (JSON)', description: 'Arquivo criptografado com PIN próprio.', onClick: clickById('btnExport') },
    { icon: 'upload', label: 'Importar backup (JSON)', description: 'Restaura um backup exportado.', onClick: clickById('btnImport') },
    { icon: 'shield', label: 'Exportar certificado', description: 'Cópia protegida; o mesmo certificado em todos os apps.', onClick: clickById('btnExportCert') },
    { icon: 'shield-check', label: 'Importar certificado', description: 'Usa o certificado de outro aparelho.', onClick: clickById('btnImportCert') },
    { icon: 'trash', label: 'Limpar lançamentos', description: 'Apaga despesas, entradas, cartão e dívidas.', danger: true, onClick: clickById('btnReset') },
  ] });

  // ---------- tabs ----------
  document.querySelectorAll('nav.tabs button').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.querySelectorAll('nav.tabs button').forEach(function(b){b.classList.remove('active');});
      document.querySelectorAll('section.panel').forEach(function(p){p.classList.remove('active');});
      btn.classList.add('active');
      document.getElementById('panel-'+btn.dataset.tab).classList.add('active');
    });
  });

  // ---------- forms ----------
  // Lê um campo de valor (reais) e devolve centavos inteiros; 0 se vazio, inválido ou acima do teto (B5).
  function readAmount(id){ var c = Engine.parseCents(document.getElementById(id).value); return c > 0 && c <= Engine.MAX_CENTS ? c : 0; }

  document.getElementById('formDespesa').addEventListener('submit', function(e){
    e.preventDefault();
    var valor = readAmount('dValor');
    var desc = document.getElementById('dDesc').value.trim();
    var venc = document.getElementById('dVenc').value;
    if (!(valor > 0) || !desc || !venc) return;
    state.expenses.push(Engine.makeExpense({valor: valor, descricao: desc, vencimento: venc}));
    this.reset();
    save(); renderAll();
  });

  document.getElementById('formEntrada').addEventListener('submit', function(e){
    e.preventDefault();
    var valor = readAmount('eValor');
    var desc = document.getElementById('eDesc').value.trim();
    var data = document.getElementById('eData').value;
    if (!(valor > 0) || !desc || !data) return;
    state.income.push(Engine.makeIncome({valor: valor, descricao: desc, data: data, contaId: state.contas.length > 1 ? document.getElementById('eConta').value : ''}));
    this.reset();
    save(); renderAll();
  });

  document.getElementById('formConta').addEventListener('submit', function(e){
    e.preventDefault();
    var saldo = Engine.parseCents(document.getElementById('kSaldo').value), data = document.getElementById('kData').value;
    var nome = document.getElementById('kNome').value.trim();
    if (saldo === null || Math.abs(saldo) > Engine.MAX_CENTS || !nome || !data) return;
    Engine.addAccount(state, {nome: nome, saldoInicial: saldo, dataSaldoInicial: data});
    this.reset(); document.getElementById('kData').value = hoje();
    save(); renderAll();
  });

  document.getElementById('conciliacao').addEventListener('submit', function(e){
    var form = e.target.closest('form.rec'); if (!form) return;
    e.preventDefault();
    var contaId = form.closest('.rec-box').dataset.conta, banco = Engine.parseCents(form.elements.banco.value);
    if (banco === null || Math.abs(banco) > Engine.MAX_CENTS) return;
    state.reconciliacao[contaId] = {saldoBanco: banco, data: hoje()};
    save(); renderAll();
  });

  document.getElementById('formConfigCartao').addEventListener('submit', function(e){
    e.preventDefault();
    var limite = readAmount('cLimite');
    var fechamento = Math.min(31, Math.max(1, parseInt(document.getElementById('cFechamento').value) || 1));
    var venc = Math.min(31, Math.max(1, parseInt(document.getElementById('cVencimento').value) || Engine.defaultVencimentoDia(fechamento)));
    state.card.limite = limite;
    state.card.fechamento = fechamento;
    state.card.vencimentoDia = venc;
    save(); renderAll();
  });

  document.getElementById('formCartao').addEventListener('submit', function(e){
    e.preventDefault();
    var valor = readAmount('ccValor');
    var desc = document.getElementById('ccDesc').value.trim();
    var data = document.getElementById('ccData').value;
    if (!(valor > 0) || !desc || !data) return;
    var tipo = document.getElementById('ccTipo').value;
    var parcelas = Math.min(48, Math.max(1, parseInt(document.getElementById('ccParcelas').value) || 1));
    Engine.addCardPurchase(state, {valor: valor, descricao: desc, data: data, tipo: tipo, parcelas: parcelas});
    this.reset();
    document.getElementById('ccData').value = hoje();
    save(); renderAll();
  });

  document.getElementById('formDivida').addEventListener('submit', function(e){
    e.preventDefault();
    var valorParcela = readAmount('vValor');
    var desc = document.getElementById('vDesc').value.trim();
    var parcelas = Math.min(1200, Math.max(1, parseInt(document.getElementById('vParcelas').value) || 1));
    var venc = document.getElementById('vVenc').value;
    if (!(valorParcela > 0) || !desc || !venc) return;
    var contratado = readAmount('vContratado');
    var taxaTxt = document.getElementById('vTaxa').value.replace(',', '.'), taxa = taxaTxt === '' ? NaN : Number(taxaTxt);
    state.debts.push({id: uid(), valorParcela: valorParcela, descricao: desc, parcelas: parcelas, parcelaAtual: 1, vencimento: venc,
      diaOriginal: Engine.parseISO(venc).d, pago: false, pagas: [], valorContratado: contratado > 0 ? contratado : null,
      taxa: Number.isFinite(taxa) && taxa >= 0 && taxa <= 1000 ? taxa : null, categoria: 'Dívidas'});
    this.reset();
    document.getElementById('vParcelas').value = 1;
    document.getElementById('vVenc').value = hoje();
    save(); renderAll();
  });

  // ---------- row actions (event delegation) ----------
  document.querySelector('.wrap').addEventListener('click', async function(e){
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var row = btn.closest('.row');
    var id = row.dataset.id;
    var action = btn.dataset.action;
    var r;

    if (action === 'pay-expense') {
      var exp = Engine.findExpense(state, id);
      if (!exp) return;
      var pg = await askPayment({title: 'Pagar "' + exp.descricao + '"', text: 'Vencimento em ' + dateBR(exp.vencimento) + ' · valor ' + fmt(exp.valor) + '. Informe quando e quanto foi pago.', valor: exp.valor});
      if (!pg) return;
      r = Engine.payExpense(state, id, pg, hoje());
      if (!r.ok) { await showMessage('Não foi possível pagar', r.erro); return; }
    } else if (action === 'unpay-expense') {
      var pe = Engine.findExpense(state, id);
      if (!pe) return;
      var ok = await askConfirm({title: 'Estornar o pagamento?', text: '"' + pe.descricao + '" volta para "em aberto"' + (pe.origem && pe.origem.tipo === 'divida' ? ' e a parcela volta para a aba Dívidas.' : '.'), action: 'Estornar', danger: true});
      if (!ok) return;
      r = Engine.unpayExpense(state, id);
      if (!r.ok) { await showMessage('Não foi possível estornar', r.erro); return; }
    } else if (action === 'del-expense') {
      var chk = Engine.canDeleteExpense(state, id);
      if (!chk.ok) { await showMessage('Exclusão bloqueada', chk.motivo); return; }
      if (!await askConfirm({title: 'Excluir esta despesa?', text: 'Esta ação não pode ser desfeita.', action: 'Excluir', danger: true})) return;
      Engine.deleteExpense(state, id);
    } else if (action === 'del-income') {
      if (!await askConfirm({title: 'Excluir esta entrada?', text: 'Esta ação não pode ser desfeita.', action: 'Excluir', danger: true})) return;
      state.income = state.income.filter(function(x){return x.id!==id;});
    } else if (action === 'del-card-item') {
      var item = state.card.lancamentos.find(function(x){return x.id===id;});
      if (!item) return;
      var restantes = item.compraId ? state.card.lancamentos.filter(function(x){return x.compraId===item.compraId;}).length : 1;
      if (!await askConfirm({title: restantes > 1 ? 'Excluir a compra parcelada?' : 'Excluir este lançamento do cartão?', text: restantes > 1 ? 'Serão removidas as ' + restantes + ' parcelas ainda em aberto desta compra.' : 'Esta ação não pode ser desfeita.', action: 'Excluir', danger: true})) return;
      Engine.deleteCardItem(state, id);
    } else if (action === 'close-invoice') {
      r = Engine.closeInvoice(state, id, hoje());
      if (!r.ok) { await showMessage('Não foi possível fechar', r.erro); return; }
      save(); renderAll();
      if (r.despesa) document.querySelector('nav.tabs button[data-tab="despesas"]').click();
      else await showMessage('Fatura sem valor a pagar', 'Os créditos cobriram as compras do ciclo. A sobra abate a próxima fatura.', false);
      return;
    } else if (action === 'reopen-invoice') {
      if (!await askConfirm({title: 'Reabrir esta fatura?', text: 'Os lançamentos voltam para o cartão e a despesa da fatura é removida de Despesas.', action: 'Reabrir', danger: true})) return;
      r = Engine.reopenInvoice(state, id);
      if (!r.ok) { await showMessage('Não foi possível reabrir', r.erro); return; }
    } else if (action === 'pay-debt') {
      var d = Engine.findDebt(state, id);
      if (!d) return;
      var pd = await askPayment({title: 'Pagar parcela ' + d.parcelaAtual + '/' + d.parcelas, text: d.descricao + ' · vencimento ' + dateBR(d.vencimento) + '. O pagamento vira uma despesa paga em Despesas.', valor: d.valorParcela, action: 'Pagar parcela'});
      if (!pd) return;
      r = Engine.payDebtInstallment(state, id, pd, hoje());
      if (!r.ok) { await showMessage('Não foi possível pagar', r.erro); return; }
    } else if (action === 'undo-debt') {
      var ud = Engine.findDebt(state, id);
      if (!ud || !ud.pagas.length) return;
      if (!await askConfirm({title: 'Desfazer o último pagamento?', text: 'A parcela ' + ud.pagas[ud.pagas.length-1].parcela + ' volta a ficar em aberto e a despesa gerada é removida.', action: 'Desfazer', danger: true})) return;
      r = Engine.undoDebtPayment(state, id);
      if (!r.ok) { await showMessage('Não foi possível desfazer', r.erro); return; }
    } else if (action === 'conf-entrada' || action === 'conf-saida') {
      var tipoM = action === 'conf-entrada' ? 'entrada' : 'saida';
      var alvo = tipoM === 'entrada' ? state.income.find(function(x){return x.id===id;}) : Engine.findExpense(state, id);
      if (alvo) Engine.setConferido(state, tipoM, id, !alvo.conferido);
    } else if (action === 'del-conta') {
      if (!await askConfirm({title: 'Excluir esta conta?', text: 'Os lançamentos continuam existindo e passam a valer para a primeira conta.', action: 'Excluir', danger: true})) return;
      Engine.removeAccount(state, id);
    } else if (action === 'del-debt') {
      if (!await askConfirm({title: 'Excluir esta dívida?', text: 'As despesas já geradas por parcelas pagas continuam em Despesas.', action: 'Excluir', danger: true})) return;
      state.debts = state.debts.filter(function(x){return x.id!==id;});
      state.expenses.forEach(function(x){ if (x.origem && x.origem.tipo === 'divida' && x.origem.id === id) x.origem = null; });
    }
    save(); renderAll();
  });

  // ---------- export / import / reset ----------
  document.getElementById('btnExport').addEventListener('click', async function(){
    try { await window.exportProtected(state, 'gerenc-fin:backup', 'livro-caixa-'+hoje()+'.secure.json'); }
    catch (_) { showMessage('Exportação falhou', 'Não foi possível exportar o backup protegido.'); }
  });

  document.getElementById('btnImport').addEventListener('click', function(){ document.getElementById('importFile').click(); });
  document.getElementById('importFile').addEventListener('change', function(e){
    var file=e.target.files[0]; if (!file) return;
    var reader=new FileReader();
    reader.onload=async function(ev){
      try {
        var payload=JSON.parse(ev.target.result), data, oldFormat=false;
        if (payload && payload.format === 'financ-encrypted-v1') {
          const password = await window.askSecret('Senha do backup (ou o PIN, em arquivos antigos):', false, true);
          if (!password) return;
          data = await FinancVault.unprotect(payload, password, 'gerenc-fin:backup');
        } else if (payload && payload.encrypted) {
          var pin=await window.askSecret('Digite a senha do backup antigo:', false, true);
          if (!pin) return;
          var cert=certFor(payload.certId);
          if (payload.certProtected && (!cert || payload.certId !== cert.id)) throw new Error('certificado do dispositivo não corresponde');
          var key=await deriveKey(pin,fromB64(payload.salt),payload.certProtected ? cert : null);
          data=await unseal({iv:payload.iv,ciphertext:payload.ciphertext},key);
          oldFormat=true; // formato anterior ao cofre (150 mil iterações): vale exportar de novo
        } else {
          throw new Error('backup não criptografado');
        }
        if (!await askConfirm({title: 'Substituir todos os dados?', text: 'Importar este arquivo vai substituir todos os dados atuais.', action: 'Importar', danger: true})) return;
        normalizeState(data); await save(); renderAll();
        document.getElementById('saveStatus').textContent='backup importado e salvo criptografado'+(oldFormat?'. Este backup usa a proteção antiga: exporte um novo para ficar com a proteção atual.':'');
      } catch(err) { showMessage('Backup inválido', 'Backup inválido, senha incorreta ou arquivo não criptografado.'); }
    };
    reader.readAsText(file); e.target.value='';
  });

  document.getElementById('btnRecover').addEventListener('click', window.lockVault);
  document.getElementById('btnBiometric').addEventListener('click', () => window.vaultSettings());

  document.getElementById('btnReset').addEventListener('click', async function(){
    if (await askConfirm({title: 'Apagar todos os lançamentos?', text: 'Isso vai apagar TODOS os dados deste navegador. Tem certeza?', action: 'Apagar tudo', danger: true})) {
      state=freshState(); save().then(renderAll);
    }
  });

  document.getElementById('btnExportCert').addEventListener('click', async function(){
    try { if (FinancCert.linked) await FinancCert.export(); else { const cert=getDeviceCert(); await window.exportProtected(cert, 'gerenc-fin:certificate', 'gerenc-fin-'+cert.id+'.cert.secure.json'); } }
    catch (_) { showMessage('Exportação falhou', 'Não foi possível exportar o certificado protegido.'); }
  });
  document.getElementById('btnImportCert').addEventListener('click', function(){ document.getElementById('importCertFile').click(); });
  document.getElementById('importCertFile').addEventListener('change', function(e){
    var file=e.target.files[0]; if (!file) return;
    var reader=new FileReader();
    reader.onload=async function(ev){
      try {
        var cert=await window.importCertificate(JSON.parse(ev.target.result), 'gerenc-fin:certificate');
        if (!cert || !cert.id || !cert.secret) throw new Error('certificado inválido');
        if (!await askConfirm({title: 'Importar certificado?', text: FinancCert.linked ? 'Ele passa a ser o certificado de todos os apps; o atual continua guardado para os backups antigos.' : 'Importar este certificado substituirá o certificado deste navegador.', action: 'Importar'})) return;
        await saveCert(cert);
        await showMessage('Certificado importado', 'Recarregue o aplicativo antes de abrir o backup.', false);
      } catch(err) { showMessage('Certificado inválido', 'Arquivo de certificado inválido.'); }
    };
    reader.readAsText(file); e.target.value='';
  });

  // ---------- init ----------
  document.getElementById('dataHoje').textContent = new Date().toLocaleDateString('pt-BR', {day:'2-digit', month:'long', year:'numeric'});
  ['dVenc','eData','ccData','vVenc','kData'].forEach(function(id){
    var el = document.getElementById(id);
    if (el && !el.value) el.value = hoje();
  });

  try { await load(); renderAll(); } catch (error) { document.getElementById('gateStatus').textContent = error.message || 'Falha na migração. Os dados anteriores foram preservados.'; }
})().catch(() => window.lockVault());
