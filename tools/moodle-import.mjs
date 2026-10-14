// Refresh the copy of the Moodle deadlines built into the app, from a calendar export.
// The scheduled job (moodle-sync.mjs) keeps the app current; this built-in copy is only
// what the app shows before its first fetch, so it rarely needs refreshing.
//
// Usage: node tools/moodle-import.mjs <calendar.ics>
//
// Get the file on Moodle: Calendar → Import or export calendars → Export calendar,
// with "All events" and "Custom range". The script rewrites the block between the
// moodle:start and moodle:end markers in index.html and bumps CACHE_VERSION in sw.js,
// so installed copies show the update pill once the change is pushed.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCK, mergeRows, parseDue, readBlock } from "./moodle-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = join(ROOT, "index.html"), SW = join(ROOT, "sw.js");

function fail(msg) { console.error(msg); process.exit(1); }
const file = process.argv[2];
if (!file) fail("Usage: node tools/moodle-import.mjs <calendar.ics>");
const text = readFileSync(file, "utf8");
if (!text.includes("BEGIN:VCALENDAR")) fail("That file is not a calendar export.");

const html = readFileSync(HTML, "utf8");
const block = readBlock(html);
if (!block) fail("index.html has no moodle:start / moodle:end block.");
const { rows: fresh, stamp } = parseDue(text);
const { rows, kept } = mergeRows(fresh, block.due);

const pad = (n) => String(n).padStart(2, "0");
const at = stamp ? new Date(stamp) : new Date();
const asOf = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
const lines = rows.map((d) => " " + JSON.stringify(d).replace(/</g, "\\u003c")).join(",\n");
const next = `/* moodle:start */\nvar MOODLE = {asOf:"${asOf}", due:[\n${lines}${lines ? "\n" : ""}]};\n/* moodle:end */`;
if (next === block.text) { console.log("No change: the app already has these deadlines."); process.exit(0); }

const sw = readFileSync(SW, "utf8");
const v = /const CACHE_VERSION = 'v(\d+)';/.exec(sw);
if (!v) fail("sw.js has no CACHE_VERSION line.");
writeFileSync(HTML, html.replace(BLOCK, () => next));
writeFileSync(SW, sw.replace(v[0], `const CACHE_VERSION = 'v${+v[1] + 1}';`));
console.log(`Copied ${fresh.length} Moodle deadlines${kept ? `, kept ${kept} that have passed` : ""} (calendar as of ${asOf}).`);
console.log(`Service worker is now v${+v[1] + 1}. Commit and push to publish.`);
