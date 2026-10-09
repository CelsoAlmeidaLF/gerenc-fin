# Livro-Caixa

Gerenciador financeiro pessoal em página estática (GitHub Pages). Os dados ficam só no aparelho, criptografados
com o cofre local; não há servidor, conta nem serviço pago.

## Funcionalidades

- **Despesas**: vencimento, categoria, tipo (fixa/variável), baixa com data e valor pago (juros/multa ou desconto),
  estorno de pagamento, lançamentos recorrentes mensais.
- **Entradas**: com categoria e recorrência (ex.: salário).
- **Cartão**: limite, dia de fechamento e dia de vencimento; faturas por ciclo; compra parcelada; crédito/estorno;
  reabrir fatura ainda não paga.
- **Dívidas**: parcelas com vencimento estável no mês, saldo devedor, valor contratado e taxa (informativos),
  pagar parcela (gera despesa paga) e desfazer.
- **Relatório** (menu ⋮ → Relatório do mês, em tela própria): resultado do mês (receitas, fixas, variáveis, dívidas), despesas por categoria, orçamento mensal
  por categoria e projeção de caixa em 30/60/90 dias.
- Backup criptografado pelas 12 palavras (Configurações; sem senha extra, abre em outro aparelho com as palavras), tema claro/escuro conforme o sistema, funciona offline (service worker).

## Regras de cálculo

- **Dinheiro em centavos inteiros** (schema 2); formatado em BRL só na exibição. Teto: R$ 999.999.999,99.
- **Datas locais** (`AAAA-MM-DD`); "hoje" é recalculado a cada uso. Nunca UTC.
- **Realizado (caixa)** do mês: entradas com data até hoje + despesas pagas pela *data do pagamento* (valor efetivamente pago).
- **Previsto (competência)** do mês: despesas pelo *vencimento* + parcelas de dívidas do mês + faturas previstas do
  cartão que vencem no mês. **Em atraso**: em aberto com vencimento antes do mês.
- **Cartão**: a compra entra no ciclo pela data (até o dia de fechamento, inclusive); fechamento em dia inexistente
  vai para o último dia do mês; vencimento = primeiro dia de vencimento depois do fechamento. Fatura só pode ser
  fechada depois da data de fechamento e gera uma despesa vinculada.
- **Limite disponível** = limite − lançamentos em aberto (inclui parcelas futuras) − faturas cuja despesa ainda não foi paga.
- **Parcelas** (cartão e dívidas): o resto da divisão em centavos fica na primeira parcela; o dia do mês original é
  preservado (31/01 → 28/02 → 31/03).
- **Relatório mensal** é por competência: compras no cartão contam na data de cada parcela (a despesa da fatura não é contada de novo).
- **Orçamento**: alertas em 70% e 90% do valor definido para a categoria.
- **Projeção**: entradas esperadas − despesas em aberto (inclui atrasadas) − parcelas de dívidas − faturas previstas no período.

## Estrutura

- `src/ledger-engine.js`: regras de cálculo (funções puras, UMD; roda no navegador e no Node).
- `src/app.js`: interface e persistência; `src/secure-*.js`: cofre compartilhado (não alterar aqui).
- `test/`: testes com `node --test`, sem dependências.
- `docs/auditoria-financeira-2026-09.md`: achados da auditoria e o que foi corrigido.

## Testes

```
npm test        # node --test test/
```

## Dados antigos

Estados e backups sem `schemaVersion` (valores em reais) são migrados na abertura/importação para centavos, com
valores padrão nos campos novos. Backups exportados antes desta versão continuam abrindo.
A partir da v1.10.0 o app não tem mais a aba Conta: contas, conciliação e o vínculo de lançamentos com contas
são descartados ao abrir ou importar dados antigos; os lançamentos em si continuam.
