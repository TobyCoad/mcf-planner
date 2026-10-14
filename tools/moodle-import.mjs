// Copy the deadlines from a Moodle calendar export into the app.
//
// Usage: node tools/moodle-import.mjs <calendar.ics>
//
// Get the file on Moodle: Calendar → Import or export calendars → Export calendar,
// with "All events" and "Custom range". The script rewrites the block between the
// moodle:start and moodle:end markers in index.html and bumps CACHE_VERSION in
// sw.js, so installed copies show the update pill once the change is pushed.
//
// Only deadlines ("… is due") are copied; they are the same for the whole cohort.
// Moodle's export only reaches a few days back, so deadlines that have passed are
// kept from the current block.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = join(ROOT, "index.html"), SW = join(ROOT, "sw.js");
const MODULES = [
  ["Stochastic Calculus", "SC"], ["Financial Derivatives", "FD"], ["Numerical Methods", "NM"],
  ["Statistics and Financial Data", "SFDA"], ["Financial Computing with C++", "CPP"],
];
const ORDER = ["SC", "FD", "NM", "SFDA", "CPP", "ADM"];

function fail(msg) { console.error(msg); process.exit(1); }
const file = process.argv[2];
if (!file) fail("Usage: node tools/moodle-import.mjs <calendar.ics>");
const text = readFileSync(file, "utf8");
if (!text.includes("BEGIN:VCALENDAR")) fail("That file is not a calendar export.");

const unescape = (s) => (s || "").replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
function isoTime(v) {                       // 20261022T110000Z | 20261022T110000 | 20261022
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v || "");
  if (!m) return null;
  return m[4] ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || ""}` : `${m[1]}-${m[2]}-${m[3]}`;
}

const raw = [];
let cur = null;
for (const line of text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n")) {
  if (line === "BEGIN:VEVENT") { cur = {}; continue; }
  if (line === "END:VEVENT") { if (cur) raw.push(cur); cur = null; continue; }
  if (!cur) continue;
  const i = line.indexOf(":");
  if (i > 0) cur[line.slice(0, i).split(";")[0].toUpperCase()] = line.slice(i + 1);
}

const fresh = [];
let stamp = "";
for (const r of raw) {
  if (r.DTSTAMP && r.DTSTAMP > stamp) stamp = r.DTSTAMP;
  const title = unescape(r.SUMMARY), course = unescape(r.CATEGORIES), start = isoTime(r.DTSTART);
  if (!title || !start || !/ is due$/i.test(title)) continue;
  const m = (MODULES.find(([prefix]) => course.startsWith(prefix)) || [null, "ADM"])[1];
  fresh.push([m, title.replace(/ is due$/i, ""), start]);
}

const html = readFileSync(HTML, "utf8");
const BLOCK = /\/\* moodle:start \*\/[\s\S]*?\/\* moodle:end \*\//;
const found = BLOCK.exec(html);
if (!found) fail("index.html has no moodle:start / moodle:end block.");
const inner = /due:\[([\s\S]*)\]\};/.exec(found[0]);
const old = inner && inner[1].trim() ? JSON.parse(`[${inner[1]}]`) : [];

// A passed deadline missing from the export has aged out of Moodle's window, so keep it.
// A future one that is missing was deleted, so it goes.
const listed = new Set(fresh.map((d) => d.join("|")));
const kept = old.filter((d) => !listed.has(d.join("|")) && Date.parse(d[2]) < Date.now());
const due = [...fresh, ...kept].sort((a, b) =>
  a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

const pad = (n) => String(n).padStart(2, "0");
const at = stamp ? new Date(isoTime(stamp)) : new Date();
const asOf = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
const rows = due.map((d) => " " + JSON.stringify(d).replace(/</g, "\\u003c")).join(",\n");
const block = `/* moodle:start */\nvar MOODLE = {asOf:"${asOf}", due:[\n${rows}${rows ? "\n" : ""}]};\n/* moodle:end */`;
if (block === found[0]) { console.log("No change: the app already has these deadlines."); process.exit(0); }

const sw = readFileSync(SW, "utf8");
const v = /const CACHE_VERSION = 'v(\d+)';/.exec(sw);
if (!v) fail("sw.js has no CACHE_VERSION line.");
writeFileSync(HTML, html.replace(BLOCK, () => block));
writeFileSync(SW, sw.replace(v[0], `const CACHE_VERSION = 'v${+v[1] + 1}';`));
console.log(`Copied ${fresh.length} Moodle deadlines${kept.length ? `, kept ${kept.length} that have passed` : ""} (calendar as of ${asOf}).`);
console.log(`Service worker is now v${+v[1] + 1}. Commit and push to publish.`);
