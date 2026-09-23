import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";

function canonicalPost(targetPost) {
  const url = new URL(targetPost);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/`;
}

export class LedgerWriteError extends Error {}

function parseRecord(line, profile, post) {
  const record = JSON.parse(line);
  if (
    !record ||
    record.profile !== profile ||
    record.targetPost !== post ||
    typeof record.key !== "string" ||
    !record.key
  ) {
    throw new Error("Registro inválido.");
  }
  return record;
}

async function readNdjson(filePath, profile, post) {
  const processed = new Set();
  let contents;

  try {
    contents = await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  let start = 0;
  while (start < contents.length) {
    const newline = contents.indexOf(10, start);
    const end = newline < 0 ? contents.length : newline;
    const next = newline < 0 ? contents.length : newline + 1;

    try {
      const record = parseRecord(contents.subarray(start, end).toString("utf8"), profile, post);
      processed.add(record.key);
    } catch (error) {
      if (next < contents.length) {
        throw new Error(`Registro corrompido no ledger ${filePath}: ${error.message}`, {
          cause: error,
        });
      }
      // Uma escrita interrompida só pode afetar a última linha.
      await truncate(filePath, start);
      return processed;
    }

    if (newline < 0) {
      // O JSON está completo, mas a escrita foi interrompida antes do delimitador.
      await appendFile(filePath, "\n");
    }
    start = next;
  }

  return processed;
}

async function migrateLegacyLedger(legacyPath, filePath, profile, post) {
  let contents;
  try {
    contents = JSON.parse(await readFile(legacyPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }

  if (
    contents.profile !== profile ||
    contents.targetPost !== post ||
    !contents.processed ||
    typeof contents.processed !== "object" ||
    Array.isArray(contents.processed)
  ) {
    throw new Error("Metadados inválidos no ledger anterior.");
  }

  const processed = new Set(Object.keys(contents.processed));
  const lines = Object.entries(contents.processed).map(([key, value]) =>
    JSON.stringify({
      profile,
      targetPost: post,
      key,
      author: value.author,
      processedAt: value.processedAt,
    }),
  );
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, lines.length ? `${lines.join("\n")}\n` : "", { flag: "wx" });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
  return processed;
}

export async function loadReplyLedger({ stateDir, profile, targetPost }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) {
    throw new Error("Nome de perfil inválido para o ledger.");
  }

  const post = canonicalPost(targetPost);
  const postHash = createHash("sha256").update(post).digest("hex").slice(0, 16);
  const basename = `replies-${profile}-${postHash}`;
  const filePath = path.join(stateDir, `${basename}.ndjson`);
  const legacyPath = path.join(stateDir, `${basename}.json`);
  let processed;

  try {
    processed = await readNdjson(filePath, profile, post);
    if (processed === null) {
      processed = await migrateLegacyLedger(legacyPath, filePath, profile, post);
    }
  } catch (error) {
    throw new Error(`Não foi possível ler o ledger ${filePath}: ${error.message}`, {
      cause: error,
    });
  }

  let directoryReady = false;

  return {
    filePath,
    get size() {
      return processed.size;
    },
    has(key) {
      return processed.has(key);
    },
    async markProcessed(key, author) {
      if (!key || processed.has(key)) return;
      const line = `${JSON.stringify({
        profile,
        targetPost: post,
        key,
        author,
        processedAt: new Date().toISOString(),
      })}\n`;
      try {
        if (!directoryReady) {
          await mkdir(stateDir, { recursive: true });
          directoryReady = true;
        }
        await appendFile(filePath, line);
        processed.add(key);
      } catch (error) {
        throw new LedgerWriteError(`Não foi possível atualizar o ledger: ${error.message}`, {
          cause: error,
        });
      }
    },
  };
}
