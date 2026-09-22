# Savanna Bot

Projeto em Node.js com dois modos independentes: a automação existente via Playwright para publicar comentários em um post configurado e um modo baseado na API oficial do Instagram para responder comentários ainda não respondidos pela própria conta.

## Instalação

Requer uma versão atual do Node.js (20 ou superior).

```bash
npm install
npx playwright install chromium
```

## Configuração

Edite [`config.js`](./config.js) antes de executar:

```js
export const TARGET_POST = "https://www.instagram.com/p/DdQepCPEauI/";
export const INTERVAL_MS = 120_000;
export const ACTION_LIMIT = 5;
export const RATE_LIMIT_FALLBACK_MS = 15 * 60 * 1000;
export const COMMENT_TEXTS = ["👏", "🔥", "Muito bom!", "Boraaaa "];
export const GIF_SEARCH_TERMS = ["party", "celebration", "dance", "funny"];
```

O target é sempre esse valor hardcoded; não há argumento de CLI para alterá-lo. `TARGET_POST` é usado pelos dois modos. As demais configurações desse arquivo continuam sendo usadas pelo modo comentário. `ACTION_LIMIT` limita o número de tentativas agendadas, inclusive as que falharem, evitando execução infinita.

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

Cada perfil usa um lock em `profiles/<perfil>/.bot.lock`. Locks cujo processo não existe mais são removidos automaticamente. `Ctrl+C` e `SIGTERM` fecham o Chromium e removem o lock.

## Ação atual

Atualmente, cada execução do scheduler escolhe aleatoriamente um item de `COMMENT_TEXTS`, preenche o composer do post, publica e só considera a ação concluída depois que o campo é esvaziado.

Toda a lógica específica do Instagram permanece em `src/instagram.js`. Quando executado com `--show`, o programa imprime um diagnóstico curto dos possíveis campos se o composer não for reconhecido.

## Código de GIF preservado

O fluxo experimental de GIF continua preservado em `src/instagram.js`, incluindo `performGifAction()`, para possível uso futuro. Ele não é chamado pelo scheduler atual e `GIF_SEARCH_TERMS` continua disponível na configuração.

> **Segurança:** o diretório `profiles/` contém sessões autenticadas do navegador e não deve ser compartilhado ou enviado ao Git. Ele já está no `.gitignore`.

## Modo reply

O modo `reply` usa somente a [API oficial do Instagram](https://developers.facebook.com/documentation/instagram-platform/comment-moderation), não abre navegador, não carrega Playwright e não precisa de `--profile`. A conta precisa ser profissional (Business ou Creator), e o token do fluxo Instagram Login precisa incluir as permissões `instagram_business_basic` e `instagram_business_manage_comments`.

Copie [`.env.example`](./.env.example) para `.env` e configure:

```env
INSTAGRAM_ACCESS_TOKEN=seu_token
INSTAGRAM_USER_ID=seu_id_numerico
INSTAGRAM_USERNAME=atletica
GRAPH_API_VERSION=v26.0

REPLY_TEXT=Texto fixo da resposta
REPLY_SCAN_INTERVAL_MS=60000
```

`INSTAGRAM_USER_ID`, `INSTAGRAM_ACCESS_TOKEN` e `REPLY_TEXT` são obrigatórios. `INSTAGRAM_USERNAME` é usado nos logs e como fallback de identificação do autor; o ID numérico continua sendo a identificação preferencial. Nunca coloque o token em `config.js` nem envie o arquivo `.env` ao Git — ele já está ignorado.

Execute:

```bash
npm start -- --mode reply
```

Na inicialização, o bot localiza pela URL o mesmo `TARGET_POST` definido em `config.js`, percorre todos os comentários desse post e todas as replies necessárias para verificar o autor. Comentários antigos e novos sem resposta da própria conta recebem exatamente `REPLY_TEXT`; comentários da conta e comentários já respondidos manualmente ou pelo bot são ignorados. Depois da varredura inicial, o processo repete a leitura completa dos comentários desse post no intervalo configurado.

O Instagram é a fonte de verdade: não existe arquivo local de “processados”. Assim, reiniciar o processo não duplica replies já existentes. Erros isolados de comentários são registrados sem interromper os demais; rate limits e falhas transitórias usam espera e retry controlados.

Se a Meta informar que o post possui comentários, mas o endpoint retornar somente lotes vazios, o processo encerra após três respostas vazias consecutivas. Esse cenário indica que o token/app não consegue acessar os comentários; verifique a permissão `instagram_business_manage_comments`, seu Access Level no App Dashboard, se a conta profissional foi adicionada ao app e o modo/revisão do app. O encerramento evita percorrer milhares de cursores vazios.
