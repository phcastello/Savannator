# Savanna Bot

Projeto pequeno em Node.js + Playwright para publicar comentários de texto, em intervalos controlados, em um único post do Instagram configurado no código.

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
export const COMMENT_TEXTS = ["👏", "🔥", "Muito bom!", "Boraaaa "];
export const GIF_SEARCH_TERMS = ["party", "celebration", "dance", "funny"];
```

O target é sempre esse valor hardcoded; não há argumento de CLI para alterá-lo. `ACTION_LIMIT` limita o número de tentativas agendadas, inclusive as que falharem, evitando execução infinita.

## Executar

```bash
npm start -- --profile pedro
```

O nome aceita somente letras, números, `_` e `-`.

Para depurar e inspecionar manualmente a interface durante toda a execução:

```bash
npm start -- --profile pedro --show
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
