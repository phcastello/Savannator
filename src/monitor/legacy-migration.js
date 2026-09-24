import { existsSync } from "node:fs";
import Database from "better-sqlite3";

export function importLegacyChecks(sqliteFilename, metrics) {
  const result = { importedCalango: 0, importedCacique: 0, totalLegacy: 0 };
  if (!existsSync(sqliteFilename)) return result;
  const db = new Database(sqliteFilename, { readonly: true, fileMustExist: true });
  try {
    for (const row of db.prepare("SELECT * FROM checks ORDER BY checked_at, id").iterate()) {
      result.totalLegacy += 1;
      if (metrics.append("calango", {
        checked_at: row.checked_at,
        count: row.target_count,
        method: row.target_method,
      })) result.importedCalango += 1;
      if (metrics.append("cacique", {
        checked_at: row.checked_at,
        count: row.rival_count,
        method: row.rival_method,
      })) result.importedCacique += 1;
    }
    return result;
  } finally {
    db.close();
  }
}
