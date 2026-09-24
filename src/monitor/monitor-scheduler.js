export function initialDelay(lastCheck, intervalMs, now = Date.now()) {
  if (!lastCheck) return 0;
  return Math.max(0, Date.parse(lastCheck.checked_at) + intervalMs - now);
}

export async function collectPair({ context, targetPost, rivalPost, readCount, store, now = () => new Date() }) {
  const page = await context.newPage();
  try {
    const target = await readCount(page, targetPost);
    const rival = await readCount(page, rivalPost);
    if (![target?.count, rival?.count].every((count) => Number.isSafeInteger(count) && count >= 0)) {
      throw new Error("A coleta retornou uma contagem não inteira ou aproximada.");
    }
    const check = {
      checked_at: now().toISOString(),
      target_count: target.count,
      rival_count: rival.count,
      target_method: target.method,
      rival_method: rival.method,
    };
    store.addCheck(check);
    return check;
  } finally {
    await page.close().catch(() => {});
  }
}

export function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timeout = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(true); }, ms);
    function abort() { clearTimeout(timeout); resolve(false); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
