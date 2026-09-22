function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);

    function onAbort() {
      clearTimeout(timeout);
      resolve(false);
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runScheduler({
  intervalMs,
  actionLimit,
  action,
  signal,
}) {
  if (!Number.isInteger(actionLimit) || actionLimit <= 0) {
    throw new Error("ACTION_LIMIT deve ser um número inteiro maior que zero.");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("INTERVAL_MS deve ser um número maior que zero.");
  }

  const intervalSeconds = intervalMs / 1_000;

  console.log("\nScheduler iniciado:\n");
  console.log(`Intervalo: ${intervalSeconds}s`);
  console.log(`Limite: ${actionLimit}`);

  let attempt = 1;

  while (attempt <= actionLimit) {
    if (signal?.aborted) return;

    console.log(`\n[${attempt}/${actionLimit}] Executando ação...`);

    try {
      await action({ attempt, actionLimit, signal });
      if (signal?.aborted) return;
      console.log(`[${attempt}/${actionLimit}] Concluído.`);
    } catch (error) {
      if (signal?.aborted) return;

      if (error?.name === "RateLimitError") {
        const delayMs =
          Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
            ? error.retryAfterMs
            : intervalMs;
        const delaySeconds = Math.ceil(delayMs / 1_000);

        console.warn("\nInstagram retornou HTTP 429 (Too Many Requests).");
        if (error.hasRetryAfter) {
          console.warn(`Retry-After: ${delaySeconds} segundos.`);
        }
        console.warn(`Scheduler pausado por ${delaySeconds} segundos.`);
        console.warn("Próxima tentativa após o período de cooldown.");

        if (!(await wait(delayMs, signal))) return;

        console.log("\nCooldown encerrado.");
        console.log("Retomando scheduler.");
        continue;
      }

      console.error(`[${attempt}/${actionLimit}] Falha:\n${formatError(error)}`);
    }

    attempt += 1;

    if (attempt <= actionLimit) {
      console.log(`\nPróxima execução em ${intervalSeconds} segundos.`);
      if (!(await wait(intervalMs, signal))) return;
    }
  }

  console.log(`\nLimite de ${actionLimit} ações atingido.`);
  console.log("Scheduler encerrado.");
}
