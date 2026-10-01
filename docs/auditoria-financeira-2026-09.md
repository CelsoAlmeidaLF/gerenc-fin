# Auditoria financeira de 30/09/2026: correções

Branch `fix/auditoria-financeira` (versão 1.8.0). Lógica de cálculo extraída para `src/ledger-engine.js`; interface em
`src/app.js`. Suíte: `npm test` (74 testes, `node --test`, sem dependências). Os arquivos de teste ficam em `test/`.
A interface (DOM) não tem teste automatizado: foi exercitada em Chrome headless com um harness descartável
(migração de dados legados, pagar parcela, desfazer, fechar fatura, relatório, recorrência, conta).

## Mudanças transversais

- **Schema versionado**: `schemaVersion: 2` (centavos). Sem `schemaVersion` = schema 1 (reais/float). `normalizeState`
  (dados salvos e backups importados) converte valores com `parseCents` (via texto, sem erro de float), preenche
  defaults dos campos novos (categoria "Outros", natureza "variável", conta vazia, `vencimentoDia` derivado do
  fechamento, `diaOriginal` do dia do vencimento, `pagas: []`, etc.) e grava o estado já migrado na primeira abertura.
  Testes: `test/dinheiro.test.js` (migração, idempotência, dados hostis).
- **Versão**: `data-vault-version` 1.7.0 → 1.8.0 em `src/index.html` e cache `livro-caixa-v1.8.0` em `src/sw.js`
  (que também passou a cachear `ledger-engine.js`).
- `alert`/`confirm` nativos foram trocados pelo modal do app (`<dialog class="vault-dialog">`, mesmo padrão do cofre).
- Nova UI segue `.app-head`, tokens de cor do tema do sistema e não usa o texto "FINANC". Controles de backup continuam só em Configurações.

## Itens

### C1: data "hoje" em UTC — corrigido
- **Problema**: `toISOString()` devolvia o dia seguinte após 21h em Brasília (vencimento da fatura, baixa, exportação, resumo).
- **Correção**: `localISO`/`hojeISO`/`addDays`/`addMonths` com `getFullYear/getMonth/getDate`; nenhuma data de negócio usa `toISOString`.
- **Onde**: `ledger-engine.js` (bloco de datas); `app.js` (`hoje()` em todos os usos).
- **Teste**: `test/datas.test.js` ("C1: hojeISO usa a data local", "regressão real — 21h30 em Brasília", `addDays` sem deslocamento).

### A6: valores em float — corrigido
- **Problema**: somas e formatação com `number` em reais; erro de ponto flutuante (0,1+0,2) e `parseFloat` no input.
- **Correção**: centavos inteiros no estado; `parseCents` (texto → centavos, arredonda meio-para-cima); `fmtBRL` só na exibição; `readAmount` nos formulários; `centsToInput` ao preencher campos.
- **Onde**: `ledger-engine.js` (`parseCents`, `safeCents`, `fmtBRL`, `normalizeState`); `app.js` (`readAmount`, `fmt`).
- **Teste**: `test/dinheiro.test.js` (parseCents, soma de 0,1×10, fmtBRL, migração float → centavos).

### C2: parcelas de dívidas fora do saldo e pagamento sem saída — corrigido
- **Problema**: resumo ignorava parcelas; pagar parcela só avançava o contador, sem despesa.
- **Correção**: `payDebtInstallment` gera despesa **paga** vinculada (`origem: {tipo:'divida'}`) com o valor e a data pagos; `monthSummary` inclui as parcelas do mês (sem contar a mesma parcela duas vezes: a paga vira despesa, a próxima sai do mês).
- **Onde**: `ledger-engine.js` (`payDebtInstallment`, `debtInstallments`, `monthSummary`); `app.js` (ação `pay-debt`).
- **Teste**: `test/dividas-baixas.test.js` ("C2: pagar parcela gera despesa…", "resumo do mês inclui parcelas…", "última parcela quita").

### C3: limite liberado ao fechar a fatura — corrigido
- **Correção**: `cardAvailable = limite − lançamentos em aberto − faturas cuja despesa vinculada não foi paga`. Estornar o pagamento volta a consumir o limite. Fatura legada sem despesa vinculada conta como quitada (senão travaria o limite para sempre).
- **Onde**: `ledger-engine.js` (`cardUsed`, `cardAvailable`, `faturaEmAberto`); `app.js` (`renderCartao`).
- **Teste**: `test/cartao.test.js` ("C3: limite NÃO é liberado ao fechar…", "disponível = limite − …", "fatura legada…").

### A1: resumo mistura competência e caixa — corrigido
- **Correção**: três blocos no topo. *Realizado (caixa)*: entradas até hoje e saídas pela data de pagamento (valor pago), com resultado. *Previsto (competência)*: entradas do mês, "a pagar" (vencimentos + parcelas + faturas previstas) e resultado previsto. *Em atraso (meses anteriores)*: em aberto com vencimento antes do mês, com contagem.
- **Onde**: `ledger-engine.js` (`monthSummary`); `index.html`/`app.js` (`renderSummary`).
- **Teste**: `test/dividas-baixas.test.js` ("A1: caixa usa data de pagamento…"), `test/cartao.test.js` (fatura prevista no mês do vencimento).

### A2: sem saldo real — corrigido
- **Correção**: aba **Conta** com contas (saldo inicial + data), saldo atual, marcação de movimentos como *conferidos* e conciliação (saldo informado pelo banco × app; status "confere", "diferença explicada por pendentes" ou "divergente"). Com mais de uma conta, o lançamento de entrada e a baixa escolhem a conta; itens sem conta valem para a primeira.
- **Onde**: `ledger-engine.js` (`addAccount`, `saldoConta`, `saldoAtual`, `realizedMovements`, `setConferido`, `reconcile`); `app.js` (`renderConta`).
- **Teste**: `test/conta.test.js` (10 testes).

### A3: fechamento ignora `fechamento` e vencimento = hoje+10 — corrigido
- **Correção**: novo campo "dia de vencimento". O lançamento é atribuído ao ciclo pelo dia de fechamento (até o dia, inclusive); vencimento da fatura = primeiro dia de vencimento após o fechamento. A fatura só fecha depois da data de fechamento; fechar leva ciclos anteriores ainda abertos; a UI lista os ciclos em aberto.
- **Onde**: `ledger-engine.js` (`closingDateFor`, `dueDateFor`, `openCycles`, `closeInvoice`); `app.js` (`renderCartao`).
- **Teste**: `test/cartao.test.js` ("A3: compra até o dia do fechamento…", "vencimento vem do dia de vencimento…", "agrupa lançamentos por ciclo…", "fechar leva junto ciclos anteriores").
- **Mudança de comportamento**: o botão único "fechar fatura do ciclo" some; agora cada ciclo encerrado tem seu botão.

### A4: sem compra parcelada no cartão — corrigido
- **Correção**: `parcelas` e `parcelaAtual` no lançamento; a compra gera uma linha por parcela, cada uma no mês correspondente (caem nas faturas seguintes); o limite usado inclui todas as parcelas restantes; excluir uma parcela remove as parcelas em aberto da mesma compra (com confirmação).
- **Onde**: `ledger-engine.js` (`addCardPurchase`, `splitInstallments`, `deleteCardItem`).
- **Teste**: `test/cartao.test.js` ("A4: compra parcelada…", "limite reduzido…", "parcela em 31/01…", "excluir uma parcela…").

### A5: próximo vencimento deriva no fim do mês — corrigido
- **Correção**: `diaOriginal` guardado; próximo vencimento = `min(dia, último dia do mês)` (31/01 → 28/02 → 31/03); formatação local.
- **Onde**: `ledger-engine.js` (`addMonths`, `debtInstallments`, `payDebtInstallment`).
- **Teste**: `test/dividas-baixas.test.js` ("A5: parcela de 31/01…", "cronograma restante…"), `test/datas.test.js` (`addMonths`).
- **Limite conhecido**: dívidas antigas que já derivaram (ex.: 03/03) não têm como recuperar o dia original; o app usa o dia do vencimento atual.

### M1: baixa sem data/valor pago — corrigido
- **Correção**: modal de baixa com data (não futura) e valor pago; diferença registrada como juros/multa (+) ou desconto (−) e exibida na lista de pagas; ação **estornar** devolve a despesa para "em aberto".
- **Onde**: `ledger-engine.js` (`payExpense`, `unpayExpense`, `expenseAjuste`); `app.js` (`askPayment`).
- **Teste**: `test/dividas-baixas.test.js` ("M1: valor pago diferente…", "estornar pagamento…").

### M2: `debtRemaining` não usado — corrigido
- **Correção**: saldo devedor (nominal = parcelas restantes × valor) por dívida e total (no resumo e na aba Dívidas); campos opcionais valor contratado e taxa % a.m. (informativos, não entram em cálculo).
- **Onde**: `ledger-engine.js` (`debtSaldo`, `debtSaldoTotal`); `app.js` (`renderDividas`).
- **Teste**: `test/dividas-baixas.test.js` ("M2: saldo devedor…").

### M3: pagar parcela sem confirmação/desfazer — corrigido
- **Correção**: pagar parcela abre o modal de baixa; "desfazer" (com confirmação) remove a despesa gerada e restaura parcela, vencimento e situação (também reabre dívida quitada). Só a parcela mais recente pode ser desfeita.
- **Onde**: `ledger-engine.js` (`undoDebtPayment`); `app.js`.
- **Teste**: `test/dividas-baixas.test.js` ("M3: desfazer pagamento…", "estornar a parcela que quitou…").

### M4: sem categorias — corrigido (com limites, ver Pendências)
- **Correção**: categoria em despesas, entradas e lançamentos do cartão; tipo fixa/variável na despesa; orçamento mensal por categoria com alertas 70%/90%; aba **Relatório** com receitas, fixas, variáveis, dívidas, resultado e despesas por categoria. Relatório por competência: compras do cartão contam na data de cada parcela e a despesa da fatura não é contada de novo.
- **Onde**: `ledger-engine.js` (`monthReport`, `setBudget`, `budgetStatus`, `addCategory`); `app.js` (`renderRelatorio`).
- **Teste**: `test/relatorio.test.js` (9 testes).

### M5: sem recorrência — corrigido (mensal)
- **Correção**: "Repetição: todo mês" em despesas e entradas cria um modelo que gera as ocorrências até 90 dias à frente (a cada abertura/ação/volta à tela), sem duplicar; pausar, excluir (remove futuras não pagas), fim opcional; mês apagado pelo usuário não volta; dia 31 vira último dia do mês.
- **Onde**: `ledger-engine.js` (`addRecurrence`, `materializeRecurrences`, `setRecurrenceActive`, `removeRecurrence`); `app.js` (`commit`, `renderRecorrencias`).
- **Teste**: `test/recorrencia-projecao.test.js` (7 testes de M5).

### M6: sem projeção — corrigido
- **Correção**: cartões 30/60/90 dias na aba Relatório: saldo atual + entradas esperadas − despesas em aberto (inclui atrasadas e faturas já fechadas) − parcelas de dívidas − faturas previstas dos ciclos abertos. Não altera o estado.
- **Onde**: `ledger-engine.js` (`projection`, `projectionAll`); `app.js` (`renderProjecao`).
- **Teste**: `test/recorrencia-projecao.test.js` (3 testes de M6).

### M7: `todayISO` congelado — corrigido
- **Correção**: `hoje()` chamado a cada render/ação; ao voltar para a tela (`visibilitychange`) o app recalcula data, ocorrências e resumos.
- **Teste**: `test/datas.test.js` ("M7: hojeISO é recalculado a cada chamada").

### M8: vínculo fatura ↔ despesa — corrigido
- **Correção**: `despesaId` ausente fica vazio (não aleatório); a despesa da fatura (e a da parcela de dívida) tem `origem` e **não pode ser excluída** — a UI explica e indica "reabrir fatura" / "estornar pagamento". Fatura não paga pode ser reaberta (devolve lançamentos e remove a despesa); fatura paga exige estorno antes.
- **Onde**: `ledger-engine.js` (`normalizeState`, `canDeleteExpense`, `reopenInvoice`).
- **Teste**: `test/dinheiro.test.js` ("M8: fatura sem despesaId…"), `test/dividas-baixas.test.js` ("M8: despesa vinculada…"), `test/cartao.test.js` ("M8: reabrir fatura…").

### B1: sem estorno/crédito no cartão — corrigido
- **Correção**: tipo "Crédito / estorno" no lançamento; reduz fatura e uso do limite; se o crédito superar as compras do ciclo, não gera despesa e a sobra abate a próxima fatura.
- **Teste**: `test/cartao.test.js` ("B1: crédito/estorno…", "crédito maior que as compras…").

### B2: "vence em breve" comparava `Date` com hora — corrigido
- **Correção**: `dueStatus` compara strings ISO locais (hoje até hoje+7).
- **Teste**: `test/datas.test.js` ("B2: …").

### B3: dívidas quitadas sem rótulo — corrigido
- **Correção**: a lista de quitadas mostra "total nominal (parcelas × valor)".
- **Teste**: sem teste automatizado (texto de interface); verificado no harness.

### B4: fechamento no dia 31 em meses curtos — corrigido
- **Correção**: `closingDateFor`/`dueDateFor`/`addMonths` limitam ao último dia do mês; o vencimento nunca cai no próprio dia de fechamento.
- **Teste**: `test/cartao.test.js` ("B4: …").

### B5: `safeAmount` com teto 1e15 — corrigido
- **Correção**: teto R$ 999.999.999,99 (`MAX_CENTS`) na normalização e nos formulários (`max` no HTML e `readAmount`). Valor acima do teto na importação vira 0, como antes.
- **Teste**: `test/dinheiro.test.js` ("B5: teto…").

## Pendências e limites conhecidos

- **M4**: categorias são uma lista (padrão + as criadas ao definir orçamento); não há renomear/excluir categoria nem categoria por dívida (dívidas usam "Dívidas"). Fatura antiga (anterior a esta versão) não guarda os itens: entra no relatório como uma linha "Cartão" na data do vencimento.
- **M5**: só recorrência mensal; sem editar o modelo (para mudar valor, exclua e recrie) e o horizonte de geração é fixo em 90 dias.
- **M6**: a projeção usa valores nominais (sem juros/taxa) e só conta a parcela atual de dívida como atrasada, mesmo que haja várias vencidas.
- **A2**: conciliação manual (sem importar extrato); sem transferência entre contas.
- **M2**: a taxa informada é só informativa.
- **A5**: vencimentos de dívidas já deslocados por versões anteriores não são recuperáveis.
- **Comportamento legado**: lançamentos de cartão abertos passam a ser distribuídos em ciclos pela data; ciclos já encerrados mostram o botão de gerar a despesa da fatura.
- A interface não tem teste automatizado; recomenda-se um teste manual no celular (fluxos de pagar/estornar, fechar fatura, recorrência) antes de promover para HOM.
