import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calculateAnalytics, seriesStats } from "./monitor-analytics.js";
import { DEFAULT_COMPETITION_END_AT } from "./monitor-analytics.js";
import { POSTS } from "./monitor-posts.js";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public/monitor");
const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};
const chartFile = path.resolve(publicDir, "../../node_modules/chart.js/dist/chart.umd.js");

export function createMonitorServer({ store, port, targetPost, rivalPost, endAt = DEFAULT_COMPETITION_END_AT, now = () => Date.now() }) {
  const clients = new Set();
  let nextCheckAt = null;
  const snapshot = () => {
    const history = store.getChecks();
    const targetSeries = store.getSeries("realeza");
    const rivalSeries = store.getSeries("cacique");
    const error = store.getLatestError();
    const latest = history.at(-1);
    return {
      targetPost, rivalPost,
      targetName: targetPost === POSTS.realeza.postUrl ? POSTS.realeza.name : "TARGET",
      rivalName: rivalPost === POSTS.cacique.postUrl ? POSTS.cacique.name : "RIVAL",
      competitionEndsAt: endAt, history,
      series: { target: targetSeries, rival: rivalSeries },
      targetStats: seriesStats(targetSeries),
      rivalStats: seriesStats(rivalSeries),
      analytics: calculateAnalytics(history, { endAt, asOf: now() }),
      nextCheckAt,
      lastError: error && (!latest || error.occurred_at > latest.checked_at) ? error : null,
    };
  };
  const broadcast = () => {
    const message = `event: update\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const client of clients) client.write(message);
  };
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/api/monitor") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(snapshot()));
      return;
    }
    if (pathname === "/api/monitor/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    const asset = assets[pathname];
    const filename = asset ? path.join(publicDir, asset[0]) : pathname === "/chart.js" ? chartFile : null;
    if (!filename) { response.writeHead(404); response.end("Not found"); return; }
    response.writeHead(200, { "Content-Type": asset?.[1] ?? "text/javascript; charset=utf-8" });
    createReadStream(filename).on("error", () => response.destroy()).pipe(response);
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": heartbeat\n\n");
  }, 25_000);
  heartbeat.unref();
  const endDelay = Date.parse(endAt) - now();
  const endTimer = endDelay > 0 && endDelay <= 2_147_483_647
    ? setTimeout(broadcast, endDelay)
    : null;
  endTimer?.unref();
  return {
    address() { return server.address(); },
    snapshot,
    broadcast,
    setNextCheckAt(value) { nextCheckAt = value; broadcast(); },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
    },
    async close() {
      clearInterval(heartbeat);
      if (endTimer) clearTimeout(endTimer);
      for (const client of clients) client.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
