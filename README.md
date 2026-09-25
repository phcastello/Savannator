# Savanna Bot

Bot em Node.js para comentar, responder comentários e acompanhar a disputa entre os posts da Realeza e da Cacique.

## Instalação

Requer Node.js 20 ou superior. Na pasta do projeto:

```sh
npm install
npx playwright install chromium
```

Confira `TARGET_POST` e ajuste os comentários em `config.js`. Para configurar respostas ou personalizar o monitor, copie `.env.example` para `.env` e edite os valores necessários:

```powershell
Copy-Item .env.example .env
```

## Comandos

### Comentar (modo principal)

```sh
npm start -- --mode comment --profile usuario1
```

Para outra conta, execute em outro terminal com outro perfil:

```sh
npm start -- --mode comment --profile usuario2
```

`usuario1` e `usuario2` são exemplos: use um nome diferente para cada sessão do Instagram. `--mode comment` pode ser omitido; acrescente `--show` para manter o navegador visível.

### Monitorar

```sh
npm start -- --mode monitor --profile monitor
```

Abra <http://127.0.0.1:3210>. Use um perfil diferente daquele usado para comentar. O monitor coleta os dois posts a cada **20 minutos** por padrão e atualiza a projeção quando há dados suficientes. No reinício, respeita o tempo restante desde a última coleta completa.

### Responder comentários

```sh
npm start -- --mode reply --reply-driver api
npm start -- --mode reply --reply-driver browser --profile usuario1
```

Configure antes o `.env` conforme a seção abaixo. O driver `api` é o padrão e dispensa navegador; o driver `browser` usa a sessão do perfil informado.

## Configuração

- `config.js`: `TARGET_POST` é o post da Realeza usado nos três modos. `INTERVAL_MS`, `ACTION_LIMIT` e `COMMENT_TEXTS` controlam os comentários.
- `.env` para monitor: `MONITOR_INTERVAL_MS=1200000` (20 minutos), `MONITOR_PORT=3210` e `MONITOR_END_AT` podem ser ajustados. `MONITOR_RIVAL_POST` deve ser o post da Cacique indicado em `.env.example`.
- `.env` para reply via API: preencha `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_USER_ID` e `REPLY_TEXT`. A conta profissional precisa das permissões `instagram_business_basic` e `instagram_business_manage_comments`.
- `.env` para reply via navegador: preencha `INSTAGRAM_USERNAME` e `REPLY_TEXT`. `REPLY_SCAN_INTERVAL_MS` controla as varreduras; `REPLY_INTERVAL_MS` controla o tempo entre envios.

Na primeira execução de um modo com navegador, faça login manualmente na janela aberta. As sessões ficam em `profiles/<perfil>`; não compartilhe essa pasta. Perfis diferentes podem rodar ao mesmo tempo, mas um perfil não pode ser usado por dois processos simultaneamente. Não envie `.env` ao Git.

O monitor guarda as contagens em `metrics/realeza/` e `metrics/cacique/`; `metrics/calango/` contém o histórico do antigo target. A previsão exige ao menos quatro amostras e só aparece quando a tendência é consistente e a ultrapassagem estimada ocorre antes do encerramento configurado. Em instalações com o monitor antigo, pare-o e execute `node scripts/migrate-monitor-metrics.js` uma vez para importar o histórico; o comando pode ser repetido sem duplicar dados.
