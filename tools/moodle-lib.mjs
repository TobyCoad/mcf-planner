// Shared by moodle-sync.mjs (the scheduled job) and moodle-import.mjs (by hand, from a file).
// A deadline is a [module, title, start] row: ["FD", "Week 3 Class Assignment", "2026-10-23T11:00:00Z"].

const MODULES = [
  ["Stochastic Calculus", "SC"], ["Financial Derivatives", "FD"], ["Numerical Methods", "NM"],
  ["Statistics and Financial Data", "SFDA"], ["Financial Computing with C++", "CPP"],
];
const ORDER = ["SC", "FD", "NM", "SFDA", "CPP", "ADM"];

const unescape = (s) => (s || "").replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
export function isoTime(v) {                // 20261022T110000Z | 20261022T110000 | 20261022
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v || "");
  if (!m) return null;
  return m[4] ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || ""}` : `${m[1]}-${m[2]}-${m[3]}`;
}

// The deadlines ("… is due") in a calendar export, and when the export was made.
export function parseDue(text) {
  const raw = [];
  let cur = null;
  for (const line of text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n")) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur) raw.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(":");
    if (i > 0) cur[line.slice(0, i).split(";")[0].toUpperCase()] = line.slice(i + 1);
  }
  const rows = [];
  let stamp = "";
  for (const r of raw) {
    if (r.DTSTAMP && r.DTSTAMP > stamp) stamp = r.DTSTAMP;
    const title = unescape(r.SUMMARY), course = unescape(r.CATEGORIES), start = isoTime(r.DTSTART);
    if (!title || !start || !/ is due$/i.test(title)) continue;
    const m = (MODULES.find(([prefix]) => course.startsWith(prefix)) || [null, "ADM"])[1];
    rows.push([m, title.replace(/ is due$/i, ""), start]);
  }
  return { rows, stamp: isoTime(stamp) };
}

// Moodle's export only reaches a few days back. A passed deadline missing from it has aged
// out, so it is kept; a future one that is missing was deleted, so it goes. Identical rows
// are real (one activity listed in several courses), so they are not collapsed.
export function mergeRows(fresh, old, now = Date.now()) {
  const listed = new Set(fresh.map((d) => d.join("|")));
  const kept = old.filter((d) => Array.isArray(d) && d.length >= 3 && !listed.has(d.join("|")) && Date.parse(d[2]) < now);
  const rows = [...fresh, ...kept].sort((a, b) =>
    a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return { rows, kept: kept.length };
}

// The built-in copy in index.html, between the moodle:start and moodle:end markers.
export const BLOCK = /\/\* moodle:start \*\/[\s\S]*?\/\* moodle:end \*\//;
export function readBlock(html) {
  const found = BLOCK.exec(html);
  if (!found) return null;
  const asOf = (/asOf:"([^"]*)"/.exec(found[0]) || [])[1] || "";
  const inner = /due:\[([\s\S]*)\]\};/.exec(found[0]);
  return { text: found[0], asOf, due: inner && inner[1].trim() ? JSON.parse(`[${inner[1]}]`) : [] };
}
