// build.mjs — merges data/manual.json (human-verified) with data/live.json
// (Parliament API) and injects the result into template.html -> index.html.
// Also writes reports/drift.md describing any changes and manual-layer reminders.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const manual = JSON.parse(readFileSync("data/manual.json", "utf8"));
const live = existsSync("data/live.json") ? JSON.parse(readFileSync("data/live.json", "utf8")) : null;

/* ---------- name matching ---------- */
const strip = (name) =>
  (name || "")
    .replace(/\b(Mr|Mrs|Ms|Dr|Sir|Dame|Rt Hon\.?|The Rt Hon\.?|Lord|Baroness|Viscount|Baron|Earl|Countess)\b\.?\s*/gi, "")
    .replace(/\bMP\b/gi, "")
    .trim();

// Strategy 1: surname + first initial (handles most cases)
const normSI = (name) => {
  const parts = strip(name).toLowerCase().replace(/[^a-z\s-]/g, "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return `${parts[parts.length - 1]}|${(parts[0] || "")[0] || ""}`;
};

// Strategy 2: surname only (catches single-name Lords, nickname vs full name)
const normSurname = (name) => {
  const parts = strip(name).toLowerCase().replace(/[^a-z\s-]/g, "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
};

// Strategy 3: full stripped lowercase (exact match after title removal)
const normFull = (name) => strip(name).toLowerCase().replace(/[^a-z\s-]/g, "").trim();

const personIds = new Set();
const drift = [];
let nodes = [...manual.nodes];
let memberLinks = [...manual.memberLinks];

nodes.filter((n) => n.type === "mp" || n.type === "peer").forEach((n) => personIds.add(n.id));

// Build match indices (manual nodes only)
const bySI = new Map();
const bySurname = new Map();
const byFull = new Map();
nodes.filter((n) => personIds.has(n.id)).forEach((n) => {
  // Index the primary name AND any aliases (e.g. "Emma Lewell" + "Emma Lewell-Buck")
  for (const nm of [n.name, ...(n.aliases || [])]) {
    const si = normSI(nm);
    const sur = normSurname(nm);
    const full = normFull(nm);
    if (si && !bySI.has(si)) bySI.set(si, n);
    if (sur) {
      if (bySurname.has(sur) && bySurname.get(sur) !== n) bySurname.set(sur, null); // collision → disable
      else bySurname.set(sur, n);
    }
    if (full && !byFull.has(full)) byFull.set(full, n);
  }
});

function findManualNode(apiName) {
  // Try most-specific first
  const full = normFull(apiName);
  if (full && byFull.has(full) && byFull.get(full)) return byFull.get(full);
  const si = normSI(apiName);
  if (si && bySI.has(si) && bySI.get(si)) return bySI.get(si);
  const sur = normSurname(apiName);
  if (sur && bySurname.has(sur) && bySurname.get(sur)) return bySurname.get(sur);
  return null;
}

if (live) {
  const bodyConfig = {
    defcom: { label: (m) => (m.isChair ? "Chair" : "Member"), sector: "defence" },
    btcom: { label: (m) => (m.isChair ? "Chair" : "Member"), sector: "trade" },
    mod: { label: (m) => m.post, sector: "defence" },
    shadow: { label: (m) => m.post, sector: "defence" },
  };

  for (const bodyId of manual.liveManagedBodies) {
    const liveMembers = live[bodyId];
    if (!liveMembers || !liveMembers.length) {
      drift.push(`- **${bodyId}**: no live data this run (${(live.errors || []).filter((e) => e.startsWith(bodyId)).join("; ") || "unknown"}); manual links retained.`);
      continue;
    }
    const cfg = bodyConfig[bodyId];

    // Replace only person->body links; keep institution-to-institution edges
    // and links flagged protected (e.g. Shadow PPS not in the Posts API).
    const replaceable = (l) => l.target === bodyId && personIds.has(l.source) && !l.protected;
    const oldLinks = memberLinks.filter(replaceable);
    const oldIds = new Set(oldLinks.map((l) => l.source));
    memberLinks = memberLinks.filter((l) => !replaceable(l));
    const newIds = new Set();

    for (const m of liveMembers) {
      let node = findManualNode(m.name);
      if (!node) {
        // Auto-add, but use party from API; never overwrite a manual node's party
        const id = "auto_" + strip(m.name).toLowerCase().replace(/[^a-z]/g, "").slice(0, 30);
        // Check we haven't already auto-added this id
        const existing = nodes.find((n) => n.id === id);
        if (existing) { node = existing; }
        else {
          node = {
            id, name: strip(m.name), type: m.house === "lords" ? "peer" : "mp",
            party: m.party || "Unknown", house: m.house || "commons",
            sector: cfg.sector, role: cfg.label(m),
            detail: "Auto-added from Parliament API during nightly sync — enrich and verify manually.",
            source: `Parliament API (${bodyId}), fetched ${live.fetchedAt.slice(0, 10)} — auto-added, enrich manually`,
            verified: true, autoAdded: true,
          };
          nodes.push(node);
          personIds.add(node.id);
          // Add to indices so subsequent bodies can match
          const si2 = normSI(node.name); if (si2 && !bySI.has(si2)) bySI.set(si2, node);
          const full2 = normFull(node.name); if (full2 && !byFull.has(full2)) byFull.set(full2, node);
          drift.push(`- **NEW on ${bodyId}**: ${m.name} (${m.party || "party unknown"}) — auto-added; enrich node manually.`);
        }
      }
      newIds.add(node.id);
      memberLinks.push({ source: node.id, target: bodyId, kind: "member", label: cfg.label(m) });
    }
    for (const gone of [...oldIds].filter((id) => !newIds.has(id))) {
      const n = nodes.find((x) => x.id === gone);
      drift.push(`- **LEFT ${bodyId}**: ${n ? n.name : gone} — link removed; review whether the node should stay (other roles) or go.`);
    }
  }
} else {
  drift.push("- No live.json found; built from manual data only.");
}

// Hansard monitor findings -> drift report (human decides on cohort entry)
if (existsSync("data/hansard-hits.json")) {
  try {
    const hh = JSON.parse(readFileSync("data/hansard-hits.json", "utf8"));
    for (const h of hh.hits || []) {
      drift.push(`- **HANSARD**: ${h.name} — "${h.debate}"${h.date ? ` (${h.date})` : ""}${h.excerpt ? ` — ${h.excerpt.slice(0, 120)}…` : ""}${h.link ? ` [link](${h.link})` : ""} — review for cohort entry in manual.json.`);
    }
  } catch (e) { drift.push(`- Hansard hits file unreadable: ${e.message}`); }
}

// Manual-layer staleness reminders (no API exists for these).
const ageDays = Math.floor((Date.now() - new Date(manual.lastVerified)) / 86400000);
if (ageDays > 30)
  drift.push(`- **Manual layers ${ageDays} days old** (last verified ${manual.lastVerified}). Check: new APPG register edition (publications.parliament.uk/pa/cm/cmallparty), GOV.UK PPS list, AFC APPG chair vacancy, new defence debates for interest cohorts.`);

// Inject into template
const template = readFileSync("template.html", "utf8");
const DATA = {
  builtAt: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
  nodes, memberLinks, cohorts: manual.cohorts, topics: manual.topics || [],
};
if (!template.includes("/*__DATA__*/null")) throw new Error("template marker missing");
writeFileSync("index.html", template.replace("/*__DATA__*/null", "/*__DATA__*/" + JSON.stringify(DATA)));

// Drift report
mkdirSync("reports", { recursive: true });
const body = drift.length
  ? `# Drift report — ${new Date().toISOString().slice(0, 10)}\n\n${drift.join("\n")}\n`
  : `# Drift report — ${new Date().toISOString().slice(0, 10)}\n\nNo changes. Map in sync with Parliament APIs.\n`;
writeFileSync("reports/drift.md", body);
writeFileSync("reports/has-drift", drift.length ? "1" : "0");
console.log(`index.html built: ${nodes.length} nodes, ${memberLinks.length} member links. Drift items: ${drift.length}`);
