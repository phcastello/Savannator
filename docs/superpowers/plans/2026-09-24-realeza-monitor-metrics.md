# Realeza × Cacique Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change every mode's target to Realeza, compare Realeza with Cacique, and preserve Git-versionable metrics for all three atléticas in separate folders.

**Architecture:** Store one append-only NDJSON series plus immutable post metadata per atlética. The monitor pairs Realeza and Cacique records by their shared UTC collection timestamp, while the chart can read each full series independently. Import the legacy Calango × Cacique SQLite rows idempotently before retiring it from the running monitor.

**Tech Stack:** Node.js ES modules, `node:test`, `better-sqlite3`, Playwright, Chart.js, PowerShell for local process transition.

**Spec:** `docs/superpowers/specs/2026-09-24-realeza-monitor-metrics-design.md`

## Global Constraints

- Target: Realeza `https://www.instagram.com/p/Ddg2rfCx8rn/` in `comment`, `reply`, and `monitor`.
- Rival: Cacique `https://www.instagram.com/p/Ddg4srKxvVb/`; old target: Calango `https://www.instagram.com/p/DdhsVOdTe42/`.
- Histories live in `metrics/calango/`, `metrics/cacique/`, and `metrics/realeza/`; the legacy `state/comment-monitor.sqlite` remains untouched.
- `metrics/` is Git-visible, but the monitor never runs Git commands. The user performs metrics commits manually.
- Existing dirty tracked files and untracked monitor files belong to the working tree. Preserve them; do not stage or commit their unrelated contents.
- A comparison uses only timestamps present in both current series. An isolated line is retained only as that post's observation.

## Review Focus

1. A configured post URL differing from the folder's metadata must fail before any append; Task 1 tests this.
2. Reimporting the same SQLite rows must leave exactly one line per post and timestamp; Task 2 tests this.
3. A second-file append failure must leave a recoverable isolated observation and no paired comparison; Task 1 tests this.
4. A truncated or conflicting NDJSON line must raise a clear error instead of silently changing history; Task 1 tests this.
5. The old rival history must appear in Cacique's chart series without becoming a Realeza comparison; Task 3 tests this.

---

## File map

- `src/monitor/post-metrics.js`: validate metadata and NDJSON, append observations, return individual and paired series.
- `src/monitor/monitor-posts.js`: fixed team names, roles, and post URLs.
- `src/monitor/legacy-migration.js`: read-only SQLite import into Calango and Cacique series.
- `scripts/migrate-monitor-metrics.js`: explicit one-shot production import command.
- `src/monitor/monitor-store.js`: adapt the file store to the monitor's current `addCheck`/`getChecks`/error contract.
- `src/monitor/monitor-analytics.js`: add independent per-post card statistics beside the existing paired analytics.
- `src/monitor/monitor-mode.js`: configure fixed identities, new store path and operational error path.
- `src/monitor/monitor-server.js`: expose full individual series and labels beside paired analytics.
- `public/monitor/app.js` and `index.html`: show Realeza and Cacique and draw their separate series.
- `config.js`, `.env.example`, `README.md`: switch target and explain the metric layout and manual commits.
- `test/monitor.test.js`: cover the new store, import, configuration, API and browser rendering.
- `metrics/{calango,cacique,realeza}/`: production metadata and histories, populated by the migration and first live collection.

### Task 1: Post metric files and pairing

**Files:**
- Create: `src/monitor/monitor-posts.js`
- Create: `src/monitor/post-metrics.js`
- Modify: `test/monitor.test.js`

**Interfaces:**
- Produces: `openPostMetrics(metricsRoot, posts, { appendFile = appendFileSync } = {})` where `posts` has `calango`, `cacique`, `realeza`, each `{ name, postUrl, role }`. The injected append function exists for failure tests.
- Produces: `POSTS` from `monitor-posts.js`, the three fixed identity records shown below.
- Returns: `append(slug, {checked_at,count,method})`, `addPair({checked_at,target_count,rival_count,target_method,rival_method})`, `getSeries(slug)`, `getPairs(targetSlug,rivalSlug)`.
- `getPairs` returns rows with the existing `target_count`, `rival_count`, `target_method`, `rival_method` fields so `calculateAnalytics` remains usable.

- [ ] **Step 1: Write focused failing tests** for independent series, metadata identity, idempotent append, a second-file write failure, and malformed input. Use a temporary directory and this representative assertion:

```js
const posts = {
  calango: { name: "Calango", postUrl: "https://www.instagram.com/p/DdhsVOdTe42/", role: "former_target" },
  cacique: { name: "Cacique", postUrl: "https://www.instagram.com/p/Ddg4srKxvVb/", role: "rival" },
  realeza: { name: "Realeza", postUrl: "https://www.instagram.com/p/Ddg2rfCx8rn/", role: "target" },
};
const metrics = openPostMetrics(dir, posts);
metrics.append("cacique", { checked_at: "2026-09-24T20:17:36.154Z", count: 667004, method: "hydrated_media" });
assert.equal(metrics.getSeries("cacique").length, 1);
assert.deepEqual(metrics.getPairs("realeza", "cacique"), []);
assert.equal(metrics.append("cacique", { checked_at: "2026-09-24T20:17:36.154Z", count: 667004, method: "hydrated_media" }), false);
assert.throws(() => openPostMetrics(dir, { ...posts, cacique: { ...posts.cacique, postUrl: "https://www.instagram.com/p/WRONG/" } }), /post_url/);
```

For the partial-write case, inject a write function that throws on the rival path after target append; reopen the directory and assert `getPairs("realeza", "cacique")` is empty:

```js
const broken = openPostMetrics(dir, posts, { appendFile: (filename, line) => {
  if (filename.includes("cacique")) throw new Error("disk full");
  appendFileSync(filename, line);
} });
assert.throws(() => broken.addPair(row(1, 100, 200)), /disk full/);
assert.equal(openPostMetrics(dir, posts).getPairs("realeza", "cacique").length, 0);
```

Put invalid JSON and a conflicting duplicate timestamp into separate fixture files and assert opening rejects each.

- [ ] **Step 2: Run** `node --test test/monitor.test.js`; expect the new import or assertions to fail.
- [ ] **Step 3: Implement** `monitor-posts.js` with the three fixed records, then `post-metrics.js` with `schema_version: 1` metadata; strictly parse the NDJSON line by line; reject conflicting duplicate timestamps and invalid counts; append one complete JSON line per observation. `addPair` appends target then rival; pairing intersects the two timestamp maps. Core pairing logic:

```js
export const POSTS = {
  calango: { name: "Calango", postUrl: "https://www.instagram.com/p/DdhsVOdTe42/", role: "former_target" },
  cacique: { name: "Cacique", postUrl: "https://www.instagram.com/p/Ddg4srKxvVb/", role: "rival" },
  realeza: { name: "Realeza", postUrl: "https://www.instagram.com/p/Ddg2rfCx8rn/", role: "target" },
};
const rivalByTime = new Map(getSeries(rivalSlug).map((item) => [item.checked_at, item]));
return getSeries(targetSlug).flatMap((target) => {
  const rival = rivalByTime.get(target.checked_at);
  return rival ? [{ checked_at: target.checked_at,
    target_count: target.count, rival_count: rival.count,
    target_method: target.method, rival_method: rival.method }] : [];
});
```

- [ ] **Step 4: Run** `node --test test/monitor.test.js`; expect all post-metrics tests to pass. Reopen the files in a second store instance to prove persistence.
- [ ] **Step 5: Review** `git diff --check` and the specific test output. Keep this task's changes isolated for review; the existing untracked `test/monitor.test.js` must not be committed as if it were newly authored here.

### Task 2: Idempotent legacy import

**Files:**
- Create: `src/monitor/legacy-migration.js`
- Create: `scripts/migrate-monitor-metrics.js`
- Modify: `test/monitor.test.js`

**Interfaces:**
- Consumes: `openPostMetrics` from Task 1.
- Produces: `importLegacyChecks(sqliteFilename, metrics)` returning `{ importedCalango, importedCacique, totalLegacy }`; it never writes to SQLite.

- [ ] **Step 1: Write a failing migration test** against a temporary SQLite database containing two `checks` rows. Import twice, then assert two Calango lines, two Cacique lines, zero Realeza lines, unchanged source row count and identical original timestamps/counts/methods.

```js
const first = importLegacyChecks(filename, metrics);
const second = importLegacyChecks(filename, metrics);
assert.equal(first.totalLegacy, 2);
assert.equal(second.importedCalango + second.importedCacique, 0);
assert.equal(metrics.getSeries("calango").length, 2);
assert.equal(metrics.getSeries("cacique").length, 2);
assert.equal(metrics.getSeries("realeza").length, 0);
```

- [ ] **Step 2: Run** `node --test test/monitor.test.js`; expect migration import failure.
- [ ] **Step 3: Implement** a read-only SQLite query ordered by `checked_at, id`; call `metrics.append` for Calango and Cacique with the corresponding count/method. Make `append` return whether a new line was written. Skip only a missing legacy database; propagate malformed or conflicting data.

```js
const db = new Database(sqliteFilename, { readonly: true, fileMustExist: true });
try {
  for (const row of db.prepare("SELECT * FROM checks ORDER BY checked_at, id").all()) {
    if (metrics.append("calango", { checked_at: row.checked_at, count: row.target_count, method: row.target_method })) importedCalango++;
    if (metrics.append("cacique", { checked_at: row.checked_at, count: row.rival_count, method: row.rival_method })) importedCacique++;
  }
} finally { db.close(); }
```

Create the one-shot script that opens `metrics/` with the fixed post identities, invokes `importLegacyChecks`, and prints the import totals. It must perform no import during normal monitor startup.

```js
const metrics = openPostMetrics(path.join(root, "metrics"), POSTS);
console.log(importLegacyChecks(path.join(root, "state", "comment-monitor.sqlite"), metrics));
```

- [ ] **Step 4: Run** `node --test test/monitor.test.js`; expect migration tests to pass, including repeat after reopening files. Do not run the production migration until the old monitor has stopped.
- [ ] **Step 5: Review** migration diff and test output. Keep changes in the working tree because the monitor's preexisting files are untracked.

### Task 3: Use the new series in collection and dashboard

**Files:**
- Modify: `config.js`, `src/monitor/monitor-store.js`, `src/monitor/monitor-mode.js`, `src/monitor/monitor-analytics.js`, `src/monitor/monitor-server.js`, `public/monitor/index.html`, `public/monitor/app.js`, `test/monitor.test.js`

**Interfaces:**
- Consumes: `openPostMetrics`, `importLegacyChecks`, and existing `collectPair`/`calculateAnalytics`.
- Produces: `openMonitorStore({metricsRoot,stateDir,posts})` with `addCheck`, `addError`, `getChecks`, `getSeries`, `getLatestCheck`, `getLatestError`, `close`.
- Server snapshot retains `history` as complete current pairs and adds `series: {target,rival}`, `targetStats`, `rivalStats`, and `targetName`/`rivalName`.
- `seriesStats(series)` returns `{latest,delta,rate}` where `delta` is `{count,hours}` or `null` and `rate` is comments per hour or `null`.

- [ ] **Step 1: Write failing tests** that assert `TARGET_POST` is Realeza, monitor config resolves Cacique, a historical Cacique point appears only in `series.rival`, and a new paired point enters `history`. Add an API and browser assertion that both team names appear.

```js
assert.equal(TARGET_POST, "https://www.instagram.com/p/Ddg2rfCx8rn/");
assert.equal(loadMonitorConfig({}).rivalPost, "https://www.instagram.com/p/Ddg4srKxvVb/");
assert.equal(snapshot.series.rival.length, 2);
assert.equal(snapshot.series.target.length, 1);
assert.equal(snapshot.history.length, 1);
assert.equal(snapshot.rivalStats.latest.count, 667004);
```

- [ ] **Step 2: Run** `node --test test/monitor.test.js`; expect configuration/API assertions to fail.
- [ ] **Step 3: Change** `config.js` and monitor configuration. Use the fixed identities from `monitor-posts.js`; reject an environment rival URL that differs from Cacique, so data cannot be written under the wrong atlética. Replace the pair SQLite store with the file-backed adapter. Store operational errors in `state/monitor-errors.ndjson`; the old SQLite is read only by the explicit migration step, never on normal startup. Implement `targetStats`/`rivalStats` from each series' latest observation, previous-observation delta and `theilSen` slope over its last 12 hours.

```js
export const TARGET_POST = "https://www.instagram.com/p/Ddg2rfCx8rn/";
if (config.rivalPost !== POSTS.cacique.postUrl) {
  throw new Error("MONITOR_RIVAL_POST deve corresponder ao post da Cacique.");
}
const store = openMonitorStore({ metricsRoot: path.join(root, "metrics"),
  stateDir: path.join(root, "state"), posts: POSTS });
```

```js
export function seriesStats(series) {
  const latest = series.at(-1) ?? null;
  const previous = series.at(-2);
  if (!latest) return { latest: null, delta: null, rate: null };
  const hours = previous ? (Date.parse(latest.checked_at) - Date.parse(previous.checked_at)) / 3_600_000 : null;
  const short = series.filter((item) => Date.parse(item.checked_at) >= Date.parse(latest.checked_at) - 12 * 3_600_000);
  return { latest, delta: previous && hours > 0 ? { count: latest.count - previous.count, hours } : null,
    rate: theilSen(short, (item) => item.count) };
}
```

- [ ] **Step 4: Update** server snapshot and UI to use independent chart series, named cards, post links, and paired analytics. Keep SSE payload shape backward compatible by retaining `history` and `analytics`. Render each card's count/delta/rate from its own stats; render gap/trend/forecast from `analytics`.

```js
return { targetPost, rivalPost, targetName: "Realeza", rivalName: "Cacique",
  series: { target: store.getSeries("realeza"), rival: store.getSeries("cacique") },
  targetStats: seriesStats(store.getSeries("realeza")),
  rivalStats: seriesStats(store.getSeries("cacique")),
  history, analytics: calculateAnalytics(history, { endAt, asOf: now() }),
  nextCheckAt, lastError };
```

- [ ] **Step 5: Run** `node --test test/monitor.test.js` and `npm test`; verify no test assumes the old target globally. Inspect the dashboard with the existing browser test.
- [ ] **Step 6: Review** `git diff --check` and status, keeping all preexisting edits intact.

### Task 4: Documentation and live transition

**Files:**
- Modify: `.env.example`, `README.md`, `test/monitor.test.js`
- Create during migration: `metrics/calango/post.json`, `metrics/calango/checks.ndjson`, `metrics/cacique/post.json`, `metrics/cacique/checks.ndjson`, `metrics/realeza/post.json`, `metrics/realeza/checks.ndjson`

**Interfaces:**
- Consumes: Tasks 1–3. No new runtime API.
- Produces: production histories and the running Realeza × Cacique monitor.

- [ ] **Step 1: Update documentation** with the exact target/rival, folder meanings, manual Git commands, and the rule that only shared collection timestamps enter comparison.

```powershell
git diff -- metrics/
git add -- metrics/calango metrics/cacique metrics/realeza
git commit -m "data: update post comment metrics"
```

- [ ] **Step 2: Run** `npm test` and `git diff --check`; fix any failures before touching running processes.
- [ ] **Step 3: Identify** the current `src/index.js --mode monitor` and `--mode reply` PIDs by exact command line. Stop only those processes; confirm that both exited and the SQLite row count is stable. Preserve other Node processes.
- [ ] **Step 4: Run** the migration once against `state/comment-monitor.sqlite`, then repeat it to check idempotence. Compare every legacy row with the corresponding Calango and Cacique NDJSON line. Confirm Realeza has no inherited rows. Do not delete or move SQLite, WAL, errors, reply ledgers, or browser profiles.

```powershell
node scripts/migrate-monitor-metrics.js
node scripts/migrate-monitor-metrics.js
```
- [ ] **Step 5: Start** the monitor with its existing `monitor` profile and the reply browser mode with its existing `atletica` profile, using `Start-Process -WindowStyle Hidden` on Windows. Check their logs and dashboard API; verify the active URLs and that the first new complete comparison uses Realeza × Cacique. If a fresh Instagram login is required, leave the process visible only for that interactive step and tell the user.
- [ ] **Step 6: Inspect** `git status --short` and `metrics/`. The metrics files remain available for the user's manual commit; do not commit them automatically. Report source row totals, imported counts, first new pair if collected, process status, and any limitation that remains.
