# Realeza × Cacique: target e métricas por atlética

## Objetivo

Usar `https://www.instagram.com/p/Ddg2rfCx8rn/` como `TARGET_POST` nos modos `comment`, `reply` e `monitor`. O monitor passa a comparar o post da Atlética da Realeza com o post rival da Atlética da Cacique, `https://www.instagram.com/p/Ddg4srKxvVb/`. O antigo target, `https://www.instagram.com/p/DdhsVOdTe42/`, pertence à Atlética da Calango e seu histórico deve ser preservado. Nenhum histórico da Cacique deve ser perdido.

## Armazenamento e versionamento

- `metrics/calango/post.json`, `metrics/cacique/post.json` e `metrics/realeza/post.json` identificam a atlética, a URL exata do post e a versão 1 do formato. A Calango é marcada como antigo target, a Cacique como rival e a Realeza como target atual.
- Cada pasta contém `checks.ndjson`, com uma linha por medição válida: `{ "checked_at": "2026-09-24T20:17:36.154Z", "count": 123, "method": "hydrated_media" }`. O mesmo `checked_at` identifica as duas leituras de uma coleta completa.
- `metrics/` fica fora do `.gitignore`. O programa grava os arquivos, mas não executa `git add` nem `git commit`; os commits são manuais. A documentação explica como revisar e commitar somente essas pastas.
- As oito amostras atualmente em `state/comment-monitor.sqlite` são copiadas para Calango e Cacique, com seus horários, contagens e métodos originais. O banco legado e seus erros permanecem intactos em `state/`. A migração é repetível, sem duplicar linhas, e inclui qualquer amostra válida que o monitor antigo tenha coletado antes da troca.
- A Realeza começa com histórico vazio até sua primeira coleta real. Dados da Calango nunca são atribuídos a ela.

## Coleta e comparação

O monitor lê Realeza e Cacique em sequência e aceita apenas contagens inteiras exatas. Depois de ambas as leituras, grava uma linha em cada pasta com o mesmo horário. Como duas gravações em arquivos distintos não são atômicas, a leitura da comparação considera apenas horários presentes nas duas pastas. Uma interrupção entre gravações pode deixar uma medição isolada; ela permanece no histórico do post, mas não entra em diferença, deltas pareados ou previsão. A coleta seguinte usa um novo horário e segue normalmente.

O agendamento considera a última **comparação completa**. Uma falha de leitura não grava medição nova. Erros de coleta continuam visíveis no painel e podem permanecer no armazenamento operacional ignorado pelo Git; não fazem parte dos históricos de métricas de posts. O monitor não reabre o banco legado para novas medições.

## Painel e API

A API entrega as séries individuais completas de Realeza e Cacique para o gráfico e uma série pareada para a análise comparativa existente. A série da Cacique inclui as medições feitas quando a Calango era target; a série da Realeza começa na primeira medição nova. Cartões e legenda mostram os nomes Realeza e Cacique, com as URLs dos posts. Os totais e ritmos individuais vêm dos respectivos históricos; diferença, tendência da diferença e previsão consideram somente as coletas completas do par atual. O histórico da Calango fica disponível nos arquivos versionáveis, sem aparecer como uma terceira linha na disputa atual.

## Transição operacional

O monitor e o modo `reply` estão rodando com a configuração antiga. A implantação local encerra o monitor antigo de forma controlada, faz a migração a partir do banco estável, valida os arquivos gerados e inicia o monitor novo com o mesmo perfil. O modo `reply` também precisa reiniciar para carregar o novo `TARGET_POST`; seu ledger existente continua separado por post e preservado. O processo de comentários, se estiver em execução, segue a mesma regra de reinício. O SQLite legado não é apagado nem movido.

## Verificação

- Testar URLs configuradas e a identidade de cada pasta.
- Testar migração das medições legadas, repetição sem duplicatas e preservação do banco de origem.
- Testar coleta bem sucedida, falha na segunda leitura e interrupção entre gravações; nenhuma medição parcial entra na comparação.
- Testar que o agendamento usa o último par completo e que o painel recebe séries individuais mais histórico pareado.
- Executar a suíte existente e conferir os dados migrados contra o SQLite antes de reiniciar os processos locais.
