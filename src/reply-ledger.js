import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function canonicalPost(targetPost) {
  const url = new URL(targetPost);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/`;
}

export class LedgerWriteError extends Error {}

export async function loadReplyLedger({ stateDir, profile, targetPost }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) {
    throw new Error("Nome de perfil inválido para o ledger.");
  }

  const post = canonicalPost(targetPost);
  const postHash = createHash("sha256").update(post).digest("hex").slice(0, 16);
  const filePath = path.join(stateDir, `replies-${profile}-${postHash}.json`);
  let processed = Object.create(null);

  try {
    const contents = JSON.parse(await readFile(filePath, "utf8"));
    if (
      contents.profile !== profile ||
      contents.targetPost !== post ||
      !contents.processed ||
      typeof contents.processed !== "object" ||
      Array.isArray(contents.processed)
    ) {
      throw new Error("Metadados inválidos.");
    }
    processed = Object.assign(Object.create(null), contents.processed);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Não foi possível ler o ledger ${filePath}: ${error.message}`, {
        cause: error,
      });
    }
  }

  return {
    filePath,
    get size() {
      return Object.keys(processed).length;
    },
    has(key) {
      return Object.hasOwn(processed, key);
    },
    async markProcessed(key, author) {
      if (!key || this.has(key)) return;
      const next = Object.assign(Object.create(null), processed);
      next[key] = { author, processedAt: new Date().toISOString() };
      const tempPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        await mkdir(stateDir, { recursive: true });
        await writeFile(
          tempPath,
          `${JSON.stringify({ profile, targetPost: post, processed: next }, null, 2)}\n`,
          { flag: "wx" },
        );
        await rename(tempPath, filePath);
        processed = next;
      } catch (error) {
        throw new LedgerWriteError(`Não foi possível atualizar o ledger: ${error.message}`, {
          cause: error,
        });
      } finally {
        await rm(tempPath, { force: true }).catch(() => {});
      }
    },
  };
}
