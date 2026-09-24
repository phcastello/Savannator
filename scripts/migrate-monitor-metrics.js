import path from "node:path";
import { fileURLToPath } from "node:url";
import { importLegacyChecks } from "../src/monitor/legacy-migration.js";
import { POSTS } from "../src/monitor/monitor-posts.js";
import { openPostMetrics } from "../src/monitor/post-metrics.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metrics = openPostMetrics(path.join(root, "metrics"), POSTS);
const result = importLegacyChecks(path.join(root, "state", "comment-monitor.sqlite"), metrics);
console.log(JSON.stringify(result));
