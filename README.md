# Savanna Bot

Projeto em Node.js com modos independentes para comentar, responder comentários e monitorar a quantidade total de comentários de dois posts. O modo reply pode usar a API oficial ou uma sessão do navegador.

## Monitor de comentários

```bash
npm start -- --mode monitor --profile monitor
```

Dashboard: <http://127.0.0.1:3210>. Use `--show` para manter o navegador visível. O primeiro login é manual, como nos modos que usam Playwright; a sessão permanece em `profiles/monitor`. O monitor coleta Realeza (target) e Cacique (rival) na inicialização quando a última comparação completa já venceu, depois a cada hora. Se reiniciar antes do próximo horário, aguarda o intervalo restante sem duplicar o ponto.

`TARGET_POST` é o post da Realeza em `config.js` e vale para os modos comentar, responder e monitorar. O rival é o post da Cacique; `MONITOR_RIVAL_POST` só aceita essa URL para impedir que medições de outro post entrem na pasta da Cacique. Configure intervalo, porta e encerramento no `.env` caso necessário:

```dotenv
MONITOR_RIVAL_POST=https://www.instagram.com/p/Ddg4srKxvVb/
MONITOR_INTERVAL_MS=3600000
MONITOR_PORT=3210
MONITOR_END_AT=2026-09-25T23:59:00-03:00
```

As métricas ficam em `metrics/calango/`, `metrics/cacique/` e `metrics/realeza/`. Cada pasta tem `post.json` com a identidade do post e `checks.ndjson` com horário UTC, contagem exata e método de extração. A Calango (`DdhsVOdTe42`) é o antigo target; suas medições e as da Cacique foram copiadas do banco legado. `state/comment-monitor.sqlite` permanece intacto como arquivo histórico. A Realeza (`Ddg2rfCx8rn`) começa sua própria série sem receber contagens da Calango.

Em uma instalação que ainda tenha o monitor antigo, pare-o antes de executar `node scripts/migrate-monitor-metrics.js`. O comando pode ser repetido sem duplicar linhas e não modifica o SQLite de origem.

As duas leituras novas são sequenciais; se uma leitura falhar, não há comparação nova. O painel só calcula diferença, tendência e previsão com horários presentes nas séries da Realeza e da Cacique. O gráfico mostra toda a série individual da Cacique, incluindo medições anteriores à troca, e a série própria da Realeza. Uma escrita interrompida pode deixar uma observação isolada em uma pasta; ela não entra na comparação. A falha aparece no dashboard e a tentativa seguinte ocorre em cinco minutos ou após o cooldown informado pelo Instagram. O gráfico permite 24h, 48h, 7 dias e todo o histórico; novas amostras chegam por SSE sem recarregar a página.

`metrics/` não está no `.gitignore`; as medições ficam disponíveis para commits manuais. O monitor não executa comandos Git. Para versionar os dados após conferir as novas linhas:

```bash
git status --short metrics/
git add -- metrics/calango metrics/cacique metrics/realeza
git diff --cached -- metrics/
git commit -m "data: update post comment metrics"
```

A extração procura o contador **total** em controles visíveis como “View all X comments”/“Ver todos os X comentários”, rótulos `aria-label`, metadados, JSON-LD e dados de hidratação da própria página. Nos dados de hidratação, só aceita `comment_count` inteiro associado ao shortcode exato do post visitado. Não conta elementos de comentário nem pagina comentários. Formatos inteiros com separadores de milhares são aceitos; valores abreviados como `47.5K` e `47,5 mil` são rejeitados.

O ritmo recente usa a mediana das inclinações entre pares de amostras das últimas 12 horas (Theil-Sen). A previsão pode surgir a partir de **quatro amostras** nas últimas 12 horas. Ela exige tendência de fechamento do gap nas janelas de 12 e 24 horas e nas últimas três amostras; taxa de pelo menos um comentário de diferença por hora; e ritmos compatíveis entre as janelas (razão entre 0,5 e 2). A mediana dos desvios das variações entre coletas não pode superar duas vezes a taxa estimada. A ultrapassagem precisa estar no futuro, em até 48 horas e **antes do encerramento da competição**, 25/09/2026 às 23:59 no horário de São Paulo (configurável por `MONITOR_END_AT`). O painel distingue dados insuficientes, ausência de tendência, estimativa instável, cruzamento após o encerramento e competição encerrada. A linha tracejada aparece somente quando a previsão passa esses critérios.

Para rodar junto com o commenter, use diretórios de profile diferentes:

```bash
# Terminal 1
npm start -- --mode comment --profile atletica
# Terminal 2
npm start -- --mode monitor --profile monitor
```

Os dois profiles podem estar logados na mesma conta, mas não podem compartilhar o mesmo diretório simultaneamente; o lock existente impede isso.

## Instalação

Requer uma versão atual do Node.js (20 ou superior).

```bash
npm install
npx playwright install chromium
```

## Configuração

Edite [`config.js`](./config.js) antes de executar:

```js
export const TARGET_POST = "https://www.instagram.com/p/Ddg2rfCx8rn/";
export const INTERVAL_MS = 120_000;
export const ACTION_LIMIT = 5;
export const RATE_LIMIT_FALLBACK_MS = 15 * 60 * 1000;
export const COMMENT_TEXTS = ["👏", "🔥", "Muito bom!", "Boraaaa "];
export const GIF_SEARCH_TERMS = ["party", "celebration", "dance", "funny"];
```

O target é sempre esse valor hardcoded; não há argumento de CLI para alterá-lo. `TARGET_POST` é usado pelos três modos. As demais configurações desse arquivo continuam sendo usadas pelo modo comentário. `ACTION_LIMIT` limita o número de tentativas agendadas, inclusive as que falharem, evitando execução infinita.

## Modo comentário

Este é o comportamento Playwright já existente. O comando original continua válido e usa `mode=comment` por padrão:

```bash
npm start -- --profile pedro
```

O modo também pode ser selecionado explicitamente:

```bash
npm start -- --mode comment --profile pedro
```

O nome aceita somente letras, números, `_` e `-`.

Para depurar e inspecionar manualmente a interface durante toda a execução:

```bash
npm start -- --profile pedro --show
npm start -- --mode comment --profile pedro --show
```

Com `--show`, o Chromium permanece visível durante a abertura do post, o scheduler, a seleção e a publicação do GIF. Sem a flag, a automação continua headless por padrão e abre uma janela apenas quando uma autenticação manual for necessária.

## Primeira execução

Na primeira execução, o navegador será aberto com interface visível somente para a autenticação. Faça login manualmente no Instagram, inclusive 2FA ou challenges. O programa detecta o login automaticamente, fecha o navegador visível e reinicia a automação em modo headless. A sessão é mantida em `profiles/<perfil>` e as próximas execuções começam diretamente em headless. Nenhuma credencial é solicitada ou armazenada pelo programa.

Se a sessão expirar durante a execução, o scheduler pausa e abre temporariamente o navegador visível para a reautenticação manual. Depois do login, ele volta ao modo headless, abre o post alvo e continua. A automação do post nunca roda no navegador visível.

## Outras contas e execução simultânea

Em outro terminal:

```bash
npm start -- --profile joao
```

Perfis diferentes podem rodar simultaneamente:

```bash
npm start -- --profile pedro
npm start -- --profile joao
```

O mesmo perfil não pode ser aberto por duas instâncias:

```bash
npm start -- --profile pedro
npm start -- --profile pedro
```

Cada perfil usa um lock em `profiles/<perfil>/.bot.lock`. Locks cujo processo não existe mais são removidos automaticamente. No Windows, o bot também remove um lock antigo quando o PID foi reutilizado por outro processo. `Ctrl+C` e `SIGTERM` fecham o Chromium e removem o lock.

## Ação atual

Atualmente, cada execução do scheduler escolhe aleatoriamente um item de `COMMENT_TEXTS`, preenche o composer do post, publica e só considera a ação concluída depois que o campo é esvaziado.

Toda a lógica específica do Instagram permanece em `src/instagram.js`. Quando executado com `--show`, o programa imprime um diagnóstico curto dos possíveis campos se o composer não for reconhecido.

`COMMENT_PAGE_RECYCLE_EVERY=100` no `.env` recria a Page após 100 comentários publicados, dentro do mesmo BrowserContext e mantendo a sessão. Use `0` para desabilitar. A cada 25 ações, o log mostra tempos por etapa, média recente e métricas locais de DOM, heap e RSS quando disponíveis. O scheduler continua aguardando `INTERVAL_MS` depois de cada ação; a duração da ação se soma a esse intervalo.

Após cada publicação confirmada, o terminal mostra o ritmo nos últimos 60 segundos: vermelho abaixo de 8 interações/min, amarelo de 8 a 14, verde de 15 a 29 e azul a partir de 30. Sem suporte a cores, o nome da faixa permanece visível.

## Código de GIF preservado

O fluxo experimental de GIF continua preservado em `src/instagram.js`, incluindo `performGifAction()`, para possível uso futuro. Ele não é chamado pelo scheduler atual e `GIF_SEARCH_TERMS` continua disponível na configuração.

> **Segurança:** o diretório `profiles/` contém sessões autenticadas do navegador e não deve ser compartilhado ou enviado ao Git. Ele já está no `.gitignore`.

## Modo reply

O modo `reply` aceita os drivers `api` e `browser`. Quando `--reply-driver` é omitido, o valor continua sendo `api`, preservando a compatibilidade com o comando anterior.

Copie [`.env.example`](./.env.example) para `.env` e configure:

```env
INSTAGRAM_ACCESS_TOKEN=seu_token
INSTAGRAM_USER_ID=seu_id_numerico
INSTAGRAM_USERNAME=atletica
GRAPH_API_VERSION=v26.0

REPLY_TEXT=Texto fixo da resposta
REPLY_SCAN_INTERVAL_MS=60000
```

`REPLY_TEXT` e `REPLY_SCAN_INTERVAL_MS` são compartilhados pelos dois drivers. Nunca coloque o token em `config.js` nem envie o arquivo `.env` ao Git — ele já está ignorado.

### Reply usando API

Este driver usa a [API oficial do Instagram](https://developers.facebook.com/documentation/instagram-platform/comment-moderation), não abre navegador, não carrega Playwright e não precisa de `--profile`. A conta precisa ser profissional (Business ou Creator), e o token do fluxo Instagram Login precisa incluir as permissões `instagram_business_basic` e `instagram_business_manage_comments`.

`INSTAGRAM_USER_ID`, `INSTAGRAM_ACCESS_TOKEN` e `REPLY_TEXT` são obrigatórios. `INSTAGRAM_USERNAME` é usado nos logs e como fallback de identificação do autor; o ID numérico continua sendo a identificação preferencial.

Execute:

```bash
npm start -- --mode reply --reply-driver api
```

O comando compatível anterior continua equivalente:

```bash
npm start -- --mode reply
```

Na inicialização, o bot localiza pela URL o mesmo `TARGET_POST` definido em `config.js`, percorre todos os comentários desse post e todas as replies necessárias para verificar o autor. Comentários antigos e novos sem resposta da própria conta recebem exatamente `REPLY_TEXT`; comentários da conta e comentários já respondidos manualmente ou pelo bot são ignorados. Depois da varredura inicial, o processo repete a leitura completa dos comentários desse post no intervalo configurado.

O Instagram é a fonte de verdade: não existe arquivo local de “processados”. Assim, reiniciar o processo não duplica replies já existentes. Erros isolados de comentários são registrados sem interromper os demais; rate limits e falhas transitórias usam espera e retry controlados.

Se a Meta informar que o post possui comentários, mas o endpoint retornar somente lotes vazios, o processo encerra após três respostas vazias consecutivas. Esse cenário indica que o token/app não consegue acessar os comentários; verifique a permissão `instagram_business_manage_comments`, seu Access Level no App Dashboard, se a conta profissional foi adicionada ao app e o modo/revisão do app. O encerramento evita percorrer milhares de cursores vazios.

O driver da API é a opção mais robusta, mas depende das permissões e do acesso concedidos pela Meta.

### Reply usando navegador

Este driver usa a mesma sessão persistente, login manual, reautenticação e lock de perfil do modo comentário. Ele abre exclusivamente `TARGET_POST` e processa comentários raiz em lotes incrementais. Um ledger local em `state/` registra cada reply automática confirmada, separado por perfil e post. O driver não consulta replies existentes: comentários respondidos manualmente ou por versões anteriores podem receber uma reply automática na primeira execução desta versão. Após o registro, o ledger impede novo envio para o mesmo comentário em scans futuros e após reiniciar.

Configure `INSTAGRAM_USERNAME` com o username da conta autenticada e `REPLY_TEXT` com a resposta fixa. `INSTAGRAM_ACCESS_TOKEN` e `INSTAGRAM_USER_ID` não são exigidos por este driver.

No `.env`, configure também `REPLY_INTERVAL_MS=3000` e, opcionalmente, `REPLY_MAX_PER_SCAN=0`. O intervalo de 3000 ms é apenas um exemplo configurável, não uma garantia de segurança contra limitações do Instagram.

Execute em headless:

```bash
npm start -- --mode reply --reply-driver browser --profile atletica
```

Ou mantenha o navegador visível para inspecionar a interface:

```bash
npm start -- --mode reply --reply-driver browser --profile atletica --show
```

As replies são enviadas sequencialmente, respeitando `REPLY_INTERVAL_MS` entre envios confirmados. `REPLY_MAX_PER_SCAN=0` não impõe limite; um valor positivo limita os envios por scan. Ao concluir um scan, o bot espera `REPLY_SCAN_INTERVAL_MS`, recarrega o mesmo post e inicia outra varredura. Em caso de rate limit, interrompe o scan e respeita `RATE_LIMIT_FALLBACK_MS` ou o prazo informado pelo Instagram. O Chromium permanece aberto entre os scans. Esse driver não depende da Graph API, mas é mais suscetível a mudanças na interface do Instagram.

`REPLY_PAGE_RECYCLE_EVERY=100` no `.env` interrompe um scan após 100 replies confirmadas, recria a Page no mesmo contexto e continua pelo ledger, sem reenviar os comentários já registrados. Use `0` para desabilitar. O ledger é NDJSON append-only em `state/`. O log mostra tempos por reply a cada 25 envios e métricas de DOM e heap a cada 100 comentários analisados.

O reply via navegador usa o mesmo medidor colorido de interações por minuto, atualizado somente após confirmação e gravação no ledger.
