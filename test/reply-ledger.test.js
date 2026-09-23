import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadReplyLedger } from "../src/reply-ledger.js";

const profile = "atletica";
const targetPost = "https://www.instagram.com/p/test-post/";

async function withLedger(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "savanna-ledger-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const options = { stateDir, profile, targetPost };
  return { options, ledger: await loadReplyLedger(options) };
}

test("milhares de markProcessed acrescentam linhas sem reescrever o arquivo", async (t) => {
  const { ledger } = await withLedger(t);
  for (let index = 0; index < 500; index += 1) {
    await ledger.markProcessed(`/c/${index}/`, "pedro");
  }
  const firstInode = (await stat(ledger.filePath)).ino;
  const firstContents = await readFile(ledger.filePath, "utf8");

  for (let index = 500; index < 3_000; index += 1) {
    await ledger.markProcessed(`/c/${index}/`, "pedro");
  }

  const finalContents = await readFile(ledger.filePath, "utf8");
  assert.equal((await stat(ledger.filePath)).ino, firstInode);
  assert.ok(finalContents.startsWith(firstContents));
  assert.equal(finalContents.trimEnd().split("\n").length, 3_000);
  assert.equal(ledger.size, 3_000);
  assert.equal(ledger.has("/c/2999/"), true);
});

test("restart reconstrói o Set a partir do NDJSON", async (t) => {
  const { options, ledger } = await withLedger(t);
  await ledger.markProcessed("/c/first/", "pedro");
  await ledger.markProcessed("/c/second/", "joao");
  await ledger.markProcessed("/c/first/", "pedro");

  const restarted = await loadReplyLedger(options);
  assert.equal(restarted.size, 2);
  assert.equal(restarted.has("/c/first/"), true);
  assert.equal(restarted.has("/c/second/"), true);
  assert.equal(restarted.has("/c/missing/"), false);

  const otherPost = await loadReplyLedger({ ...options, targetPost: "https://www.instagram.com/p/other/" });
  const otherProfile = await loadReplyLedger({ ...options, profile: "outro" });
  assert.equal(otherPost.size, 0);
  assert.equal(otherProfile.size, 0);
});

test("linha final truncada é ignorada e removida antes de novos appends", async (t) => {
  const { options, ledger } = await withLedger(t);
  await ledger.markProcessed("/c/first/", "pedro");
  await appendFile(ledger.filePath, '{"profile":"atletica","key":');

  const restarted = await loadReplyLedger(options);
  assert.equal(restarted.size, 1);
  await restarted.markProcessed("/c/second/", "joao");
  const afterSecondRestart = await loadReplyLedger(options);
  assert.equal(afterSecondRestart.size, 2);
  assert.equal(afterSecondRestart.has("/c/second/"), true);
});

test("última linha corrompida mesmo com delimitador é ignorada", async (t) => {
  const { options, ledger } = await withLedger(t);
  await ledger.markProcessed("/c/first/", "pedro");
  await appendFile(ledger.filePath, '{"key":\n');

  const restarted = await loadReplyLedger(options);
  assert.equal(restarted.size, 1);
  await restarted.markProcessed("/c/second/", "joao");
  assert.equal((await loadReplyLedger(options)).size, 2);
});

test("corrupção em linha intermediária gera erro", async (t) => {
  const { options, ledger } = await withLedger(t);
  await ledger.markProcessed("/c/first/", "pedro");
  await appendFile(ledger.filePath, '{"key":\n');
  await appendFile(ledger.filePath, `${JSON.stringify({
    profile,
    targetPost,
    key: "/c/second/",
    author: "joao",
  })}\n`);

  await assert.rejects(loadReplyLedger(options), /Registro corrompido/);
});

test("ledger JSON anterior migra uma vez sem perder comentários", async (t) => {
  const { options, ledger } = await withLedger(t);
  const legacyPath = ledger.filePath.replace(/\.ndjson$/, ".json");
  await writeFile(legacyPath, JSON.stringify({
    profile,
    targetPost,
    processed: {
      "/c/old/": { author: "pedro", processedAt: "2026-01-01T00:00:00.000Z" },
    },
  }));

  const migrated = await loadReplyLedger(options);
  assert.equal(migrated.size, 1);
  assert.equal(migrated.has("/c/old/"), true);
  await migrated.markProcessed("/c/new/", "joao");
  const restarted = await loadReplyLedger(options);
  assert.equal(restarted.size, 2);
  assert.equal((await readFile(migrated.filePath, "utf8")).trimEnd().split("\n").length, 2);
});
