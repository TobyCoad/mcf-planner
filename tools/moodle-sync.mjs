// Fetch the Moodle calendar export, keep deadlines and class-attendance events,
// and write them encrypted (PBKDF2-SHA256 -> AES-256-GCM) for the app to decrypt.
//
// Env: MOODLE_ICAL_URL  the personal calendar export link (a GitHub secret)
//      PLANNER_KEY      the passphrase the app is unlocked with (a GitHub secret)
//      PREV_URL         the file the live site serves now (optional)
// Usage: node tools/moodle-sync.mjs <out.enc> [local.ics]   (the .ics argument is for testing)
//
// Moodle's export only reaches a few days back, so events that have passed are
// carried over from the live file; if Moodle can't be read, the live file is kept
// as it is. Every deploy replaces the whole site, so without this a failed fetch
// would leave the app with nothing new to load.
//
// The repo is public, so its Actions logs are too: this script prints counts only,
// never the link, the response or any event text. It always exits 0 so the site
// still deploys.
import { webcrypto as crypto } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const OUT = process.argv[2] || "data/moodle.json.enc";
const LOCAL_ICS = process.argv[3];
const ITERATIONS = 310000;
const MODULES = [
  ["Stochastic Calculus", "SC"], ["Financial Derivatives", "FD"], ["Numerical Methods", "NM"],
  ["Statistics and Financial Data", "SFDA"], ["Financial Computing with C++", "CPP"],
];

const url = (process.env.MOODLE_ICAL_URL || "").trim();
const pass = (process.env.PLANNER_KEY || "").trim();
const prevUrl = (process.env.PREV_URL || "").trim();
if (!pass || (!url && !LOCAL_ICS)) {
  console.log("Moodle sync skipped: MOODLE_ICAL_URL or PLANNER_KEY is not set");
  process.exit(0);
}

const enc = new TextEncoder();
const b64 = (a) => Buffer.from(a).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
async function deriveKey(salt, iter, use) {
  const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, [use]);
}

// The live file, if it opens with this passphrase. A changed passphrase means starting afresh.
let prevRaw = null, prev = null;
if (prevUrl) {
  try {
    const res = await fetch(`${prevUrl}?t=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
    if (res.ok) {
      const raw = await res.text(), box = JSON.parse(raw);
      const key = await deriveKey(unb64(box.salt), box.iter, "decrypt");
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct));
      prev = JSON.parse(new TextDecoder().decode(pt));
      prevRaw = raw;
    }
  } catch { prev = prevRaw = null; }
}

function write(text) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, text); }
function keep(why) {
  if (prevRaw) { write(prevRaw); console.log(`Moodle sync: ${why}; kept the previous copy`); }
  else console.log(`Moodle sync skipped: ${why}`);
  process.exit(0);
}

let text;
try {
  if (LOCAL_ICS) text = readFileSync(LOCAL_ICS, "utf8");
  else {
    const res = await fetch(url, { headers: { "User-Agent": "mcf-planner-sync" }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) keep(`Moodle answered HTTP ${res.status}`);
    text = await res.text();
  }
} catch (err) { keep(`fetch failed (${err.name})`); }
if (!text.includes("BEGIN:VCALENDAR")) keep("the response was not a calendar");

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

const events = [];
for (const r of raw) {
  const title = unescape(r.SUMMARY), course = unescape(r.CATEGORIES), start = isoTime(r.DTSTART);
  if (!title || !start) continue;
  const m = (MODULES.find(([prefix]) => course.startsWith(prefix)) || [null, "ADM"])[1];
  const attend = /^Class Attendance/i.test(title);
  const kind = / is due$/i.test(title) ? "due" : attend ? "attend" : "event";
  const group = attend ? Number((title.match(/Group\s+(?:Group\s+)?(\d+)/i) || [])[1]) || null : null;
  events.push({ uid: (r.UID || "").split("@")[0], t: title, c: course, m, k: kind, g: group, s: start, e: isoTime(r.DTEND) || start });
}

// Past events that have aged out of Moodle's window. A future event that has gone was deleted, so it stays gone.
const seen = new Set(events.map((e) => e.uid));
const now = Date.now();
let kept = 0;
for (const e of (prev && prev.events) || []) {
  if (e && e.uid && !seen.has(e.uid) && Date.parse(e.e || e.s) < now) { events.push(e); kept++; }
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const key = await deriveKey(salt, ITERATIONS, "encrypt");
const payload = enc.encode(JSON.stringify({ fetched: new Date().toISOString(), events }));
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload));
write(JSON.stringify({ v: 1, kdf: "PBKDF2-SHA256", iter: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
const count = (k) => events.filter((e) => e.k === k).length;
console.log(`Moodle sync: wrote ${events.length} events (${count("due")} deadlines, ${count("attend")} class sessions, ${kept} carried over)`);
