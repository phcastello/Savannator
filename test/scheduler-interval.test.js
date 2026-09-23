import assert from "node:assert/strict";
import test from "node:test";
import { runScheduler } from "../src/scheduler.js";

test("scheduler espera INTERVAL_MS depois da ação, sem compensar sua duração", async () => {
  const starts = [];
  await runScheduler({
    intervalMs: 30,
    actionLimit: 2,
    action: async () => {
      starts.push(performance.now());
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  });
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 45);
});
