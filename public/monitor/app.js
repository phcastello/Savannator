const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("pt-BR");
const signed = (value) => `${value >= 0 ? "+" : "−"}${number.format(Math.abs(value))}`;
const formatTime = (iso) => iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";
let state;
let range = "48";
let chart;

function renderCards(data) {
  const { analytics: a, history, targetStats, rivalStats } = data;
  $("target-link").textContent = data.targetName.toUpperCase();
  $("target-link").href = data.targetPost;
  $("rival-link").textContent = data.rivalName.toUpperCase();
  $("rival-link").href = data.rivalPost;
  $("target-count").textContent = targetStats.latest ? number.format(targetStats.latest.count) : "—";
  $("rival-count").textContent = rivalStats.latest ? number.format(rivalStats.latest.count) : "—";
  for (const [slug, stats] of [["target", targetStats], ["rival", rivalStats]]) {
    const period = stats.delta?.hours ? ` (${number.format(Math.round(stats.delta.hours * 10) / 10)}h)` : "";
    $(`${slug}-delta`).textContent = `Última medição${period}: ${stats.delta ? signed(stats.delta.count) : "—"}`;
    $(`${slug}-rate`).textContent = `Ritmo recente: ${stats.rate == null ? "—" : `~${number.format(Math.round(stats.rate))}/h`}`;
  }
  $("gap").textContent = a.gap == null ? "—" : number.format(Math.abs(a.gap));
  $("leader").textContent = a.gap == null ? "Aguardando dados" : a.gap > 0 ? `${data.targetName} lidera` : a.gap < 0 ? `${data.rivalName} lidera` : "Empate";
  $("trend").textContent = a.gapSlope == null || a.gapDirection == null ? "—" : `${a.gapDirection === "closing" ? "Fechando" : "Abrindo"} ${number.format(Math.round(Math.abs(a.gapSlope)))}/h`;
  const forecasts = { insufficient_data: "Dados insuficientes", no_crossing: "Sem tendência de ultrapassagem", unstable: "Estimativa instável", after_deadline: "Sem ultrapassagem antes do fim", ended: "Competição encerrada" };
  $("forecast").textContent = a.forecast.status === "estimated" ? `~${number.format(Math.round(a.forecast.hours * 10) / 10)}h` : forecasts[a.forecast.status];
  $("forecast-at").textContent = a.forecast.status === "estimated" ? formatTime(a.forecast.at) : "";
  $("last-update").textContent = `Última atualização válida: ${formatTime(history.at(-1)?.checked_at)}`;
  $("next-check").textContent = `Próxima coleta: ${formatTime(data.nextCheckAt)}`;
  $("end-at").textContent = `Encerramento: ${new Date(data.competitionEndsAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })} (São Paulo)`;
  $("error").hidden = !data.lastError;
  if (data.lastError) $("error").textContent = `Última coleta falhou em ${formatTime(data.lastError.occurred_at)}: ${data.lastError.message}`;
}

function renderChart(data) {
  const all = data.series;
  const cutoff = range === "all" ? -Infinity : Date.now() - Number(range) * 3_600_000;
  const targetRows = all.target.filter((row) => Date.parse(row.checked_at) >= cutoff);
  const rivalRows = all.rival.filter((row) => Date.parse(row.checked_at) >= cutoff);
  const point = (row) => ({ x: Date.parse(row.checked_at), y: row.count });
  const target = targetRows.map(point);
  const rival = rivalRows.map(point);
  const projection = data.analytics.forecast.status === "estimated" ? data.analytics.forecast.projection : null;
  const lastPair = data.history.at(-1);
  const pairInRange = lastPair && Date.parse(lastPair.checked_at) >= cutoff;
  const predictedTarget = projection && pairInRange ? [{ x: Date.parse(lastPair.checked_at), y: lastPair.target_count }, { x: Date.parse(projection.at), y: projection.target }] : [];
  const predictedRival = projection && pairInRange ? [{ x: Date.parse(lastPair.checked_at), y: lastPair.rival_count }, { x: Date.parse(projection.at), y: projection.rival }] : [];
  const datasets = [
    { label: data.targetName, data: target, borderColor: "#8de3a7", backgroundColor: "#8de3a7", tension: .15 },
    { label: data.rivalName, data: rival, borderColor: "#e5b56b", backgroundColor: "#e5b56b", tension: .15 },
    { label: `${data.targetName} · projeção`, data: predictedTarget, borderColor: "#8de3a7", borderDash: [7, 6], pointRadius: 0 },
    { label: `${data.rivalName} · projeção`, data: predictedRival, borderColor: "#e5b56b", borderDash: [7, 6], pointRadius: 0 },
  ];
  const options = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 350 }, parsing: false,
    interaction: { mode: "nearest", intersect: false },
    plugins: {
      legend: { labels: { color: "#b5c9bb", filter: (item) => !item.text.includes("projeção"), usePointStyle: true } },
      tooltip: { callbacks: {
        title: (items) => formatTime(items[0]?.parsed.x),
        label: (item) => {
          const series = item.datasetIndex % 2 === 0 ? all.target : all.rival;
          const index = series.findIndex((entry) => Date.parse(entry.checked_at) === item.parsed.x);
          const delta = index > 0 && item.datasetIndex < 2 ? ` (${signed(series[index].count - series[index - 1].count)})` : "";
          return `${item.dataset.label}: ${number.format(Math.round(item.parsed.y))}${delta}`;
        },
      } },
    },
    scales: {
      x: { type: "linear", grid: { color: "#29403566" }, ticks: { color: "#849b8a", maxTicksLimit: 8, callback: (value) => new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) } },
      y: { grid: { color: "#29403566" }, ticks: { color: "#849b8a", callback: (value) => number.format(value) } },
    },
  };
  if (chart) { chart.data.datasets = datasets; chart.options = options; chart.update(); }
  else chart = new Chart($("history-chart"), { type: "line", data: { datasets }, options });
}

function render(data) { state = data; renderCards(data); renderChart(data); }
document.querySelectorAll("[data-range]").forEach((button) => button.addEventListener("click", () => {
  range = button.dataset.range;
  document.querySelectorAll("[data-range]").forEach((item) => item.classList.toggle("active", item === button));
  if (state) renderChart(state);
}));

async function start() {
  try {
    const response = await fetch("/api/monitor");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) { $("connection").textContent = `Falha ao carregar: ${error.message}`; }
  const events = new EventSource("/api/monitor/events");
  events.addEventListener("update", (event) => render(JSON.parse(event.data)));
  events.onopen = () => { $("connection").textContent = "● Ao vivo"; $("connection").classList.add("live"); };
  events.onerror = () => { $("connection").textContent = "Reconectando…"; $("connection").classList.remove("live"); };
}
start();
