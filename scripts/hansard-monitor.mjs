// hansard-monitor.mjs — nightly scan of TheyWorkForYou for new defence
// contributions by people already on the map. Findings go into
// data/hansard-hits.json; build.mjs surfaces them in the drift report so
// the human decides whether they become cohort entries. Nothing is
// auto-added to the map: contributions need reading before they earn a tie.
//
// Access strategy:
// 1. If TWFY_API_KEY is set (free from theyworkforyou.com/api), use the
//    proper getHansard API.
// 2. Otherwise fall back to TWFY's public search RSS feed.
// Both paths are parsed defensively; on shape mismatch a payload sample is
// logged so the failure self-diagnoses in the Actions log. This script
// never exits non-zero.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const OUT = "data/hansard-hits.json";
const LOOKBACK_DAYS = 2; // covers the nightly gap plus weekend slack
const QUERIES = ["defence", "armed forces", "MoD procurement"];
const UA = { headers: { "User-Agent": "parl-map hansard monitor (contact via repo)" } };

const manual = JSON.parse(readFileSync("data/manual.json", "utf8"));
const strip = (n) => (n || "")
  .replace(/\b(Mr|Mrs|Ms|Dr|Sir|Dame|Rt Hon\.?|The Rt Hon\.?|Lord|Baroness|Viscount|Baron|Earl|Countess)\b\.?\s*/gi, "")
  .replace(/\bMP\b/gi, "").trim();

// People on the map, by full stripped name for containment matching
const people = manual.nodes
  .filter((n) => n.type === "mp" || n.type === "peer")
  .map((n) => ({
    id: n.id, name: n.name,
    needles: [strip(n.name), ...(n.aliases || [])].map((x) => x.toLowerCase()).filter((x) => x.length > 5),
  }))
  .filter((p) => p.needles.length); // skip degenerate needles

const cutoff = Date.now() - LOOKBACK_DAYS * 86400000;
const hits = [];
const seen = new Set();

function recordHit(person, title, date, link, excerpt) {
  const key = `${person.id}|${link || title}`;
  if (seen.has(key)) return;
  seen.add(key);
  hits.push({
    id: person.id, name: person.name,
    debate: title || "Untitled item",
    date: date || null, link: link || null,
    excerpt: (excerpt || "").replace(/<[^>]+>/g, "").slice(0, 200),
  });
}

/* ---------- Path 1: TWFY API (needs free key) ---------- */
async function viaApi(key) {
  for (const q of QUERIES) {
    const url = `https://www.theyworkforyou.com/api/getHansard?key=${key}&search=${encodeURIComponent(q)}&order=d&num=50&output=json`;
    const r = await fetch(url, UA);
    if (!r.ok) throw new Error(`getHansard ${q}: HTTP ${r.status}`);
    const data = await r.json();
    const rows = data.rows || data.results || [];
    if (!rows.length && data) console.error(`API shape check (${q}):`, JSON.stringify(data).slice(0, 400));
    for (const row of rows) {
      const when = new Date(row.hdate || row.date || 0).getTime();
      if (when && when < cutoff) continue;
      const speaker = strip(row.speaker?.name || row.name || "").toLowerCase();
      const body = `${row.body || ""} ${row.extract || ""}`.toLowerCase();
      for (const p of people) {
        const speakerMatch = speaker && p.needles.some((nd) => speaker === nd || (speaker.split(" ").pop() === nd.split(" ").pop() && speaker[0] === nd[0]));
        const bodyMatch = p.needles.some((nd) => body.includes(nd));
        if (speakerMatch || bodyMatch) {
          recordHit(p, row.parent?.body || row.hansard_title || q, row.hdate, row.listurl ? `https://www.theyworkforyou.com${row.listurl}` : null, row.body);
        }
      }
    }
  }
}

/* ---------- Path 2: public search RSS (no key) ---------- */
function parseRss(xml) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/).slice(1);
  for (const b of blocks) {
    const g = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
    };
    items.push({ title: g("title"), link: g("link"), pubDate: g("pubDate"), description: g("description") });
  }
  return items;
}

async function viaRss() {
  for (const q of QUERIES) {
    const url = `https://www.theyworkforyou.com/search/rss/?q=${encodeURIComponent(q)}`;
    const r = await fetch(url, UA);
    if (!r.ok) { console.error(`RSS ${q}: HTTP ${r.status}`); continue; }
    const xml = await r.text();
    const items = parseRss(xml);
    if (!items.length) { console.error(`RSS ${q}: zero items. Sample:`, xml.slice(0, 400)); continue; }
    for (const it of items) {
      const when = it.pubDate ? new Date(it.pubDate).getTime() : 0;
      if (when && when < cutoff) continue;
      const hay = `${it.title} ${it.description}`.toLowerCase();
      for (const p of people) if (p.needles.some((nd) => hay.includes(nd))) recordHit(p, it.title, it.pubDate, it.link, it.description);
    }
  }
}

/* ---------- run ---------- */
try {
  const key = process.env.TWFY_API_KEY;
  if (key) { console.log("Using TWFY API"); await viaApi(key); }
  else { console.log("No TWFY_API_KEY set — using public search RSS (register a free key at theyworkforyou.com/api for better coverage)"); await viaRss(); }
} catch (e) {
  console.error("Monitor error (non-fatal):", e.message);
}

writeFileSync(OUT, JSON.stringify({ checkedAt: new Date().toISOString(), lookbackDays: LOOKBACK_DAYS, hits }, null, 1));
console.log(`hansard-hits.json: ${hits.length} hit(s) for mapped stakeholders in last ${LOOKBACK_DAYS} day(s)`);
