import assert from "node:assert/strict";
import test from "node:test";
import { createCommentRecyclePolicy, recyclePage, samplePageHealth } from "../src/page-health.js";
import { RateLimitError } from "../src/instagram.js";

function timing(totalMs = 100, localMs = 20) {
  return { totalMs, composerMs: localMs / 2, submitLookupMs: localMs / 2 };
}

test("recicla após N comentários confirmados e desabilita com zero", () => {
  const policy = createCommentRecyclePolicy(3);
  assert.equal(policy.recordSuccess(timing()), null);
  assert.equal(policy.recordSuccess(timing()), null);
  assert.equal(policy.recordSuccess(timing()), "limite fixo");
  policy.recycled();
  assert.equal(policy.recordSuccess(timing()), null);

  const disabled = createCommentRecyclePolicy(0);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(disabled.recordSuccess(timing(500, 300)), null);
  }
});

test("reciclagem adaptativa exige baseline, locators lentos e cooldown", () => {
  const policy = createCommentRecyclePolicy(100);
  for (let index = 0; index < 20; index += 1) {
    assert.equal(policy.recordSuccess(timing(100, 20)), null);
  }
  for (let index = 0; index < 9; index += 1) {
    assert.equal(policy.recordSuccess(timing(400, 300)), null);
  }
  assert.equal(policy.recordSuccess(timing(400, 300)), "degradação dos locators");
  policy.failed();
  for (let index = 0; index < 24; index += 1) {
    assert.equal(policy.recordSuccess(timing(400, 300)), null);
  }
  assert.equal(policy.recordSuccess(timing(400, 300)), "degradação dos locators");
});

test("troca Page no mesmo contexto só depois de preparar a nova", async () => {
  const events = [];
  const oldPage = { close: async () => { events.push("fechar antiga"); } };
  const newPage = { close: async () => { events.push("fechar nova"); } };
  const context = { newPage: async () => { events.push("criar nova"); return newPage; } };

  const result = await recyclePage(context, oldPage, async (candidate) => {
    assert.equal(candidate, newPage);
    events.push("post carregado e login confirmado");
  });
  assert.equal(result, newPage);
  assert.deepEqual(events, ["criar nova", "post carregado e login confirmado", "fechar antiga"]);
});

test("falha ao criar ou preparar Page mantém a antiga e propaga rate limit", async () => {
  let oldClosed = false;
  let newClosed = false;
  const oldPage = { close: async () => { oldClosed = true; } };
  const newPage = { close: async () => { newClosed = true; } };

  await assert.rejects(
    recyclePage({ newPage: async () => { throw new Error("criação falhou"); } }, oldPage, async () => {}),
    /criação falhou/,
  );
  assert.equal(oldClosed, false);

  const rateLimit = new RateLimitError(900_000);
  await assert.rejects(
    recyclePage({ newPage: async () => newPage }, oldPage, async () => { throw rateLimit; }),
    (error) => error === rateLimit,
  );
  assert.equal(oldClosed, false);
  assert.equal(newClosed, true);
});

test("métricas CDP indisponíveis não impedem coleta de RSS", async () => {
  const health = await samplePageHealth({
    context: () => ({ newCDPSession: async () => { throw new Error("sem CDP"); } }),
  });
  assert.ok(health.nodeRss > 0);
});
