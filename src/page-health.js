const METRIC_WINDOW = 25;

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function seconds(ms) {
  return `${(ms / 1_000).toFixed(2)}s`;
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function samplePageHealth(page) {
  const health = { nodeRss: process.memoryUsage().rss };
  let session;
  try {
    session = await page.context().newCDPSession(page);
    const counters = await session.send("Memory.getDOMCounters").catch(() => null);
    if (counters) {
      health.nodes = counters.nodes;
      health.documents = counters.documents;
      health.listeners = counters.jsEventListeners;
    }
    await session.send("Performance.enable").catch(() => {});
    const metrics = await session.send("Performance.getMetrics").catch(() => null);
    health.rendererHeap = metrics?.metrics?.find(
      (metric) => metric.name === "JSHeapUsedSize",
    )?.value;
  } catch {
    // CDP pode não estar disponível; RSS e tempos continuam válidos.
  } finally {
    await session?.detach().catch(() => {});
  }
  return health;
}

export function createPerformanceReporter(label, { intervalMs } = {}) {
  let actions = 0;
  const recent = [];

  return {
    async record(page, timing) {
      actions += 1;
      recent.push(timing);
      if (recent.length > METRIC_WINDOW) recent.shift();
      if (actions % METRIC_WINDOW !== 0) return;

      const totalAverage = average(recent.map((item) => item.totalMs));
      console.log(
        `\nPerformance ${label}: ações ${actions}, última ${seconds(timing.totalMs)}, ` +
          `média últimas ${METRIC_WINDOW} ${seconds(totalAverage)}.`,
      );
      if (label === "comment") {
        console.log(
          `Execução agendada média ${METRIC_WINDOW}: ` +
            `${seconds(average(recent.map((item) => item.scheduledMs ?? item.totalMs)))}.`,
        );
        console.log(
          `Ciclo: execução agendada + INTERVAL_MS (${seconds(intervalMs ?? 0)}); ` +
            "o tempo acima mede apenas a publicação.",
        );
        const stages = [
          ["composer", "composerMs"],
          ["preencher", "fillMs"],
          ["localizar submit", "submitLookupMs"],
          ["submit", "submitMs"],
          ["confirmar", "confirmMs"],
        ];
        console.log(
          `Etapas médias: ${stages.map(([name, key]) =>
            `${name} ${seconds(average(recent.map((item) => item[key] ?? 0)))}`,
          ).join(", ")}.`,
        );
      }

      const health = await samplePageHealth(page);
      const details = [
        Number.isFinite(health.nodes) && `DOM nodes ${health.nodes}`,
        Number.isFinite(health.documents) && `documents ${health.documents}`,
        Number.isFinite(health.listeners) && `listeners ${health.listeners}`,
        Number.isFinite(health.rendererHeap) && `heap renderer ${megabytes(health.rendererHeap)}`,
        `RSS Node ${megabytes(health.nodeRss)}`,
      ].filter(Boolean);
      console.log(details.join(", ") + ".");
    },
  };
}

export function createCommentRecyclePolicy(every) {
  let successful = 0;
  let onPage = 0;
  let retryNextAt = 0;
  let adaptiveNextAt = 0;
  const baseline = [];
  const recent = [];

  return {
    recordSuccess(timing) {
      successful += 1;
      onPage += 1;
      const localMs = (timing.composerMs ?? 0) + (timing.submitLookupMs ?? 0);
      if (baseline.length < 20) baseline.push({ totalMs: timing.totalMs, localMs });
      recent.push({ totalMs: timing.totalMs, localMs });
      if (recent.length > 10) recent.shift();

      if (every === 0 || successful < retryNextAt) return null;
      if (onPage >= every) return "limite fixo";
      if (successful < adaptiveNextAt) return null;
      if (baseline.length < 20 || recent.length < 10 || onPage < 30) return null;

      const baselineTotal = average(baseline.map((item) => item.totalMs));
      const baselineLocal = average(baseline.map((item) => item.localMs));
      const recentTotal = average(recent.map((item) => item.totalMs));
      const recentLocal = average(recent.map((item) => item.localMs));
      return recentTotal > baselineTotal * 2.5 &&
        recentLocal > Math.max(baselineLocal * 2.5, 250)
        ? "degradação dos locators"
        : null;
    },
    recycled() {
      onPage = 0;
      baseline.length = 0;
      recent.length = 0;
      adaptiveNextAt = successful + 25;
      retryNextAt = successful;
    },
    failed() {
      retryNextAt = successful + 25;
    },
    resetPage() {
      onPage = 0;
      baseline.length = 0;
      recent.length = 0;
      adaptiveNextAt = successful + 25;
      retryNextAt = successful;
    },
  };
}

export async function recyclePage(context, oldPage, preparePage) {
  let newPage;
  try {
    newPage = await context.newPage();
    await preparePage(newPage);
  } catch (error) {
    await newPage?.close().catch(() => {});
    throw error;
  }

  await oldPage.close().catch((error) => {
    console.warn(`Não foi possível fechar a Page antiga: ${error.message}`);
  });
  return newPage;
}
