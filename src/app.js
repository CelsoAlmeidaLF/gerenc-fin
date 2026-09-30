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
        meta: 'vence em ' + dateBR(x.vencimento),
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
      return rowHtml({
        id: x.id,
        title: escapeHtml(x.descricao),
        meta: 'pago em ' + dateBR(x.dataPagamento),
        amt: fmt(x.valor),
        amtClass: '',
        paid: true,
        actions: [{label:'excluir', cls:'del', action:'del-expense'}]
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

  function cardUsedTotal(){
    return state.card.lancamentos.reduce(function(s,x){return s + Number(x.valor);}, 0);
  }

  function renderCartao(){
    document.getElementById('cLimite').value = state.card.limite ? Engine.centsToInput(state.card.limite) : '';
    document.getElementById('cFechamento').value = state.card.fechamento || '';

    var usado = cardUsedTotal();
    var limite = Number(state.card.limite)||0;
    var pct = limite > 0 ? Math.min(100, (usado/limite)*100) : 0;
    var disponivel = Math.max(0, limite - usado);

    document.getElementById('cartaoUsadoLabel').textContent = fmt(usado);
    document.getElementById('cartaoLimiteLabel').textContent = fmt(limite);
    document.getElementById('cartaoFill').style.width = pct + '%';
    document.getElementById('sumCartao').textContent = fmt(disponivel);

    var bar = document.getElementById('limiteBar');
    bar.classList.remove('warn','danger');
    if (pct >= 90) bar.classList.add('danger');
    else if (pct >= 70) bar.classList.add('warn');

    document.getElementById('cartaoConfigInfo').innerHTML =
      'fechamento todo dia <b>' + (state.card.fechamento||'-') + '</b> &nbsp;·&nbsp; disponível <b>' + fmt(disponivel) + '</b>';

    var abertos = state.card.lancamentos.slice().sort(function(a,b){return b.data.localeCompare(a.data);});
    document.getElementById('listCartaoAberto').innerHTML = abertos.length ? abertos.map(function(x){
      return rowHtml({
        id: x.id,
        title: escapeHtml(x.descricao),
        meta: dateBR(x.data),
        amt: fmt(x.valor),
        amtClass: 'neg',
        paid: false,
        actions: [{label:'excluir', cls:'del', action:'del-card-item'}]
      });
    }).join('') : '<div class="empty">nenhum lançamento no ciclo atual.</div>';

    var faturas = state.card.faturas.slice().sort(function(a,b){return b.dataFechamento.localeCompare(a.dataFechamento);});
    document.getElementById('listFaturas').innerHTML = faturas.length ? faturas.map(function(f){
      var despesa = state.expenses.find(function(e){return e.id === f.despesaId;});
      var pago = despesa ? despesa.pago : false;
      return rowHtml({
        id: f.id,
        title: 'fatura fechada em ' + dateBR(f.dataFechamento) + (pago ? ' <span class="tag paid">paga</span>' : ' <span class="tag due-soon">a pagar</span>'),
        meta: despesa ? ('lançada em Despesas · vence ' + dateBR(despesa.vencimento)) : 'sem despesa vinculada',
        amt: fmt(f.total),
        amtClass: pago ? '' : 'neg',
        paid: pago,
        actions: []
      });
    }).join('') : '<div class="empty">nenhuma fatura fechada ainda.</div>';
  }

  function debtRemaining(d){
    return d.parcelas - d.parcelaAtual + 1;
  }

  function renderDividas(){
    var abertas = state.debts.filter(function(d){return !d.pago;}).sort(function(a,b){return a.vencimento.localeCompare(b.vencimento);});
    var quitadas = state.debts.filter(function(d){return d.pago;});

    document.getElementById('listDividasAbertas').innerHTML = abertas.length ? abertas.map(function(d){
      return rowHtml({
        id: d.id,
        title: escapeHtml(d.descricao) + ' · parcela ' + d.parcelaAtual + '/' + d.parcelas + dueTag(d.vencimento,false),
        meta: 'próximo vencimento ' + dateBR(d.vencimento),
        amt: fmt(d.valorParcela),
        amtClass: 'neg',
        paid: false,
        actions: [
          {label:'pagar parcela', cls:'pay', action:'pay-debt'},
          {label:'excluir', cls:'del', action:'del-debt'}
        ]
      });
    }).join('') : '<div class="empty">nenhuma dívida em aberto.</div>';

    document.getElementById('listDividasQuitadas').innerHTML = quitadas.length ? quitadas.map(function(d){
      return rowHtml({
        id: d.id,
        title: escapeHtml(d.descricao),
        meta: d.parcelas + ' parcela(s) quitada(s)',
        amt: fmt(d.valorParcela * d.parcelas),
        amtClass: '',
        paid: true,
        actions: [{label:'excluir', cls:'del', action:'del-debt'}]
      });
    }).join('') : '<div class="empty">nenhuma dívida quitada ainda.</div>';
  }

  function monthKey(iso){ return iso ? iso.slice(0,7) : ''; }

  function renderSummary(){
    var mk = Engine.monthKey(hoje());
    var entradasMes = state.income.filter(function(x){return monthKey(x.data)===mk;}).reduce(function(s,x){return s+Number(x.valor);},0);
    var despesasMes = state.expenses.filter(function(x){return monthKey(x.vencimento)===mk;}).reduce(function(s,x){return s+Number(x.valor);},0);
    document.getElementById('sumEntradas').textContent = fmt(entradasMes);
    document.getElementById('sumDespesas').textContent = fmt(despesasMes);
    var saldo = entradasMes - despesasMes;
    var saldoEl = document.getElementById('sumSaldo');
    saldoEl.textContent = fmt(saldo);
    saldoEl.style.color = saldo < 0 ? 'var(--rust)' : 'var(--green)';
  }

  function renderAll(){
    renderDespesas();
    renderEntradas();
    renderCartao();
    renderDividas();
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
    state.expenses.push({id: uid(), valor: valor, descricao: desc, vencimento: venc, pago: false, dataPagamento: null});
    this.reset();
    save(); renderAll();
  });

  document.getElementById('formEntrada').addEventListener('submit', function(e){
    e.preventDefault();
    var valor = readAmount('eValor');
    var desc = document.getElementById('eDesc').value.trim();
    var data = document.getElementById('eData').value;
    if (!(valor > 0) || !desc || !data) return;
    state.income.push({id: uid(), valor: valor, descricao: desc, data: data});
    this.reset();
    save(); renderAll();
  });

  document.getElementById('formConfigCartao').addEventListener('submit', function(e){
    e.preventDefault();
    var limite = readAmount('cLimite');
    var fechamento = parseInt(document.getElementById('cFechamento').value) || 1;
    state.card.limite = limite;
    state.card.fechamento = Math.min(31, Math.max(1, fechamento));
    save(); renderAll();
  });

  document.getElementById('formCartao').addEventListener('submit', function(e){
    e.preventDefault();
    var valor = readAmount('ccValor');
    var desc = document.getElementById('ccDesc').value.trim();
    var data = document.getElementById('ccData').value;
    if (!(valor > 0) || !desc || !data) return;
    state.card.lancamentos.push({id: uid(), valor: valor, descricao: desc, data: data});
    this.reset();
    save(); renderAll();
  });

  document.getElementById('formDivida').addEventListener('submit', function(e){
    e.preventDefault();
    var valorParcela = readAmount('vValor');
    var desc = document.getElementById('vDesc').value.trim();
    var parcelas = parseInt(document.getElementById('vParcelas').value) || 1;
    var venc = document.getElementById('vVenc').value;
    if (!(valorParcela > 0) || !desc || !venc) return;
    state.debts.push({id: uid(), valorParcela: valorParcela, descricao: desc, parcelas: parcelas, parcelaAtual: 1, vencimento: venc, pago: false});
    this.reset();
    document.getElementById('vParcelas').value = 1;
    save(); renderAll();
  });

  document.getElementById('btnFecharFatura').addEventListener('click', function(){
    if (!state.card.lancamentos.length) { alert('Não há lançamentos no ciclo atual para fechar.'); return; }
    var total = cardUsedTotal();
    var faturaId = uid();
    var hojeStr = hoje();
    var vencISO = Engine.addDays(hojeStr, 10);
    var despesaId = uid();
    state.expenses.push({id: despesaId, valor: total, descricao: 'Fatura do cartão (' + dateBR(hojeStr) + ')', vencimento: vencISO, pago: false, dataPagamento: null});
    state.card.faturas.push({id: faturaId, total: total, dataFechamento: hojeStr, despesaId: despesaId});
    state.card.lancamentos = [];
    save(); renderAll();
    document.querySelector('nav.tabs button[data-tab="despesas"]').click();
  });

  // ---------- row actions (event delegation) ----------
  document.querySelector('.wrap').addEventListener('click', function(e){
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var row = btn.closest('.row');
    var id = row.dataset.id;
    var action = btn.dataset.action;

    if (action === 'pay-expense') {
      var exp = state.expenses.find(function(x){return x.id===id;});
      if (exp) { exp.pago = true; exp.dataPagamento = hoje(); }
    } else if (action === 'del-expense') {
      if (confirm('Excluir esta despesa?')) state.expenses = state.expenses.filter(function(x){return x.id!==id;});
    } else if (action === 'del-income') {
      if (confirm('Excluir esta entrada?')) state.income = state.income.filter(function(x){return x.id!==id;});
    } else if (action === 'del-card-item') {
      if (confirm('Excluir este lançamento do cartão?')) state.card.lancamentos = state.card.lancamentos.filter(function(x){return x.id!==id;});
    } else if (action === 'pay-debt') {
      var d = state.debts.find(function(x){return x.id===id;});
      if (d) {
        if (d.parcelaAtual >= d.parcelas) {
          d.pago = true;
        } else {
          d.parcelaAtual += 1;
          var nextDate = new Date(d.vencimento + 'T00:00:00');
          nextDate.setMonth(nextDate.getMonth() + 1);
          d.vencimento = Engine.localISO(nextDate);
        }
      }
    } else if (action === 'del-debt') {
      if (confirm('Excluir esta dívida?')) state.debts = state.debts.filter(function(x){return x.id!==id;});
    }
    save(); renderAll();
  });

  // ---------- export / import / reset ----------
  document.getElementById('btnExport').addEventListener('click', async function(){
    try { await window.exportProtected(state, 'gerenc-fin:backup', 'livro-caixa-'+hoje()+'.secure.json'); }
    catch (_) { alert('Não foi possível exportar o backup protegido.'); }
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
        if (!confirm('Importar este arquivo vai substituir todos os dados atuais. Continuar?')) return;
        normalizeState(data); await save(); renderAll();
        document.getElementById('saveStatus').textContent='backup importado e salvo criptografado'+(oldFormat?'. Este backup usa a proteção antiga: exporte um novo para ficar com a proteção atual.':'');
      } catch(err) { alert('Backup inválido, senha incorreta ou arquivo não criptografado.'); }
    };
    reader.readAsText(file); e.target.value='';
  });

  document.getElementById('btnRecover').addEventListener('click', window.lockVault);
  document.getElementById('btnBiometric').addEventListener('click', () => window.vaultSettings());

  document.getElementById('btnReset').addEventListener('click', function(){
    if (confirm('Isso vai apagar TODOS os dados deste navegador. Tem certeza?')) {
      state=freshState(); save().then(renderAll);
    }
  });

  document.getElementById('btnExportCert').addEventListener('click', async function(){
    try { if (FinancCert.linked) await FinancCert.export(); else { const cert=getDeviceCert(); await window.exportProtected(cert, 'gerenc-fin:certificate', 'gerenc-fin-'+cert.id+'.cert.secure.json'); } }
    catch (_) { alert('Não foi possível exportar o certificado protegido.'); }
  });
  document.getElementById('btnImportCert').addEventListener('click', function(){ document.getElementById('importCertFile').click(); });
  document.getElementById('importCertFile').addEventListener('change', function(e){
    var file=e.target.files[0]; if (!file) return;
    var reader=new FileReader();
    reader.onload=async function(ev){
      try {
        var cert=await window.importCertificate(JSON.parse(ev.target.result), 'gerenc-fin:certificate');
        if (!cert || !cert.id || !cert.secret) throw new Error('certificado inválido');
        if (!confirm(FinancCert.linked ? 'Importar este certificado? Ele passa a ser o certificado de todos os apps; o atual continua guardado para os backups antigos.' : 'Importar este certificado substituirá o certificado deste navegador. Continuar?')) return;
        await saveCert(cert);
        alert('Certificado importado. Recarregue o aplicativo antes de abrir o backup.');
      } catch(err) { alert('Arquivo de certificado inválido.'); }
    };
    reader.readAsText(file); e.target.value='';
  });

  // ---------- init ----------
  document.getElementById('dataHoje').textContent = new Date().toLocaleDateString('pt-BR', {day:'2-digit', month:'long', year:'numeric'});
  ['dVenc','eData','ccData','vVenc'].forEach(function(id){
    var el = document.getElementById(id);
    if (el && !el.value) el.value = hoje();
  });

  try { await load(); renderAll(); } catch (error) { document.getElementById('gateStatus').textContent = error.message || 'Falha na migração. Os dados anteriores foram preservados.'; }
})().catch(() => window.lockVault());
