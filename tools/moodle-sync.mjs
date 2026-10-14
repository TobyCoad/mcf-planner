// The scheduled job: fetch the Moodle calendar and write its deadlines to moodle.json,
// which the app fetches when it opens.
//
// Env: MOODLE_ICAL_URL  the personal calendar export link (a repository secret)
//      PREV_URL         the moodle.json the live site serves now (optional)
// Usage: node tools/moodle-sync.mjs <out.json> [local.ics]   (the .ics argument is for testing)
//
// The repo is public and so are its Actions logs: this prints counts only, never the link or
// any event text. It always exits 0 so the site still deploys. If Moodle can't be read, the
// live file is kept as it is; with no file at all the app uses the copy built into index.html.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeRows, parseDue, readBlock } from "./moodle-lib.mjs";

const OUT = process.argv[2] || "moodle.json";
const LOCAL_ICS = process.argv[3];
const url = (process.env.MOODLE_ICAL_URL || "").trim();
const prevUrl = (process.env.PREV_URL || "").trim();
const HTML = join(dirname(fileURLToPath(import.meta.url)), "..", "index.html");

let prev = null, prevRaw = null;
if (prevUrl) {
  try {
    const res = await fetch(`${prevUrl}?t=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
    if (res.ok) {
      const raw = await res.text(), p = JSON.parse(raw);
      if (p && Array.isArray(p.due) && typeof p.checked === "string") { prev = p; prevRaw = raw; }
    }
  } catch { prev = prevRaw = null; }
}

function say(msg) { console.log(`Moodle sync: ${msg}`); process.exit(0); }
function keep(why) {
  if (prevRaw) { writeFileSync(OUT, prevRaw); say(`${why}; kept the previous copy`); }
  say(`skipped (${why})`);
}

if (!url && !LOCAL_ICS) keep("MOODLE_ICAL_URL is not set");
let text;
try {
  if (LOCAL_ICS) text = readFileSync(LOCAL_ICS, "utf8");
  else {
    const res = await fetch(url, { headers: { "User-Agent": "mcf-planner-sync" }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) keep(`Moodle answered HTTP ${res.status}`);
    text = await res.text();
  }
} catch (err) { keep(`the fetch failed (${err.name})`); }
if (!text.includes("BEGIN:VCALENDAR")) keep("the response was not a calendar");

const now = Date.now();
const { rows: fresh } = parseDue(text);
// The history of passed deadlines: the live file, or before there is one, the built-in copy.
const old = prev ? prev.due : ((readBlock(readFileSync(HTML, "utf8")) || {}).due || []);
// No deadlines at all while upcoming ones were listed before is more likely a Moodle hiccup than the truth.
if (!fresh.length && old.some((d) => Date.parse(d[2]) >= now)) keep("the export listed no deadlines");
const { rows, kept } = mergeRows(fresh, old, now);
writeFileSync(OUT, JSON.stringify({ v: 1, checked: new Date(now).toISOString(), due: rows }));
say(`${rows.length} deadlines (${fresh.length} from Moodle, ${kept} carried over)`);
