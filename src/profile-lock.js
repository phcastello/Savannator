import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class ProfileInUseError extends Error {
  constructor(profile) {
    super(`O perfil "${profile}" já está sendo utilizado por outra instância.`);
    this.name = "ProfileInUseError";
  }
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readLock(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

async function removeAbandonedLock(lockPath) {
  const lock = await readLock(lockPath);

  // Um lock ilegível pode estar sendo escrito neste exato momento. Nesse caso,
  // é mais seguro considerá-lo ativo do que remover o lock de outro processo.
  if (!lock) {
    return false;
  }

  if (isProcessRunning(lock.pid)) {
    if (process.platform !== "win32") return false;

    // O Windows pode reutilizar um PID depois que o bot encerra sem limpar o lock.
    // A nova instância não pode ter começado depois da criação deste lock.
    const lockCreatedAt = Date.parse(lock.createdAt);
    if (!Number.isFinite(lockCreatedAt)) return false;

    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${lock.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ], { timeout: 5000 });
      const processStartedAt = Date.parse(stdout.trim());
      if (!Number.isFinite(processStartedAt) || processStartedAt <= lockCreatedAt) {
        return false;
      }
    } catch {
      // Sem confirmação da data de início, preservamos o lock.
      if (isProcessRunning(lock.pid)) return false;
    }
  }

  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    return false;
  }
}

export async function acquireProfileLock(profileDir, profile) {
  await mkdir(profileDir, { recursive: true });

  const lockPath = path.join(profileDir, ".bot.lock");
  const lockId = randomUUID();
  const contents = JSON.stringify(
    { pid: process.pid, lockId, createdAt: new Date().toISOString() },
    null,
    2,
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;

    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(contents, "utf8");
      await handle.close();

      let released = false;
      return {
        path: lockPath,
        async release() {
          if (released) return;
          released = true;

          const currentLock = await readLock(lockPath);
          if (currentLock?.lockId !== lockId) return;

          try {
            await unlink(lockPath);
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      await handle?.close().catch(() => {});

      if (error?.code !== "EEXIST") throw error;

      const removed = await removeAbandonedLock(lockPath);
      if (!removed) throw new ProfileInUseError(profile);
    }
  }

  throw new ProfileInUseError(profile);
}
