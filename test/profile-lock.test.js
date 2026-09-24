import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireProfileLock, ProfileInUseError } from "../src/profile-lock.js";

test("bloqueia uma segunda instância enquanto o perfil está em uso", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "savanna-profile-lock-"));
  try {
    const lock = await acquireProfileLock(dir, "teste");
    try {
      await assert.rejects(acquireProfileLock(dir, "teste"), ProfileInUseError);
    } finally {
      await lock.release();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("remove lock antigo quando o Windows reutiliza o PID", { skip: process.platform !== "win32" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "savanna-profile-lock-"));
  try {
    await writeFile(path.join(dir, ".bot.lock"), JSON.stringify({
      pid: process.pid,
      lockId: "anterior",
      createdAt: "2000-01-01T00:00:00.000Z",
    }));

    const lock = await acquireProfileLock(dir, "teste");
    await lock.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
