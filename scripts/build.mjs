// build.mjs — merges data/manual.json (human-verified) with data/live.json
// (Parliament API) and injects the result into template.html -> index.html.
// Also writes reports/drift.md describing any changes and manual-layer reminders.
//
// Merge rules:
// - Bodies listed in manual.liveManagedBodies get their membership REPLACED by live data.
// - People are matched manual<->live by normalised surname + first initial.
// - A live member with no manual node is AUTO-ADDED with source "Parliament API,
//   auto-added — enrich manually" so provenance stays honest.
// - A manual person no longer on a live body loses that LINK but keeps their node;
//   the drift report flags them (they may hold other roles, or need removal by a human).
// - Everything else (APPGs, cohorts, analytical groupings) passes through untouched.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const manual = JSON.parse(readFileSync("data/manual.json", "utf8"));
const live = existsSync("data/live.json") ? JSON.parse(readFileSync("data/live.json", "utf8")) : null;

const norm = (name) => {
  const stripped = (name || "").replace(/\b(Mr|Mrs|Ms|Dr|Sir|Dame|Rt Hon\.?|The)\b\.?\s*/gi, "");
  const parts = stripped.toLowerCase().replace(/[^a-z\s-]/g, "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return `${parts[parts.length - 1]}|${(parts[0] || "")[0] || ""}`;
};
const personIds = new Set();

const drift = [];
let nodes = [...manual.nodes];
let memberLinks = manual.memberLinks.filter((l) => true);
nodes.filter((n) => n.type === "mp" || n.type === "peer").forEach((n) => personIds.add(n.id));
const nodeByNorm = new Map(nodes.filter((n) => personIds.has(n.id)).map((n) => [norm(n.name), n]));

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
    // (e.g. sub-committee of) and links flagged protected (e.g. Shadow PPS,
    // which never appears in the posts API).
    const replaceable = (l) => l.target === bodyId && personIds.has(l.source) && !l.protected;
    const oldLinks = memberLinks.filter(replaceable);
    const oldIds = new Set(oldLinks.map((l) => l.source));
    memberLinks = memberLinks.filter((l) => !replaceable(l));
    const newIds = new Set();

    for (const m of liveMembers) {
      let node = nodeByNorm.get(norm(m.name));
      if (!node) {
        const id = "auto_" + norm(m.name).replace(/[^a-z]/g, "");
        node = {
          id, name: m.name, type: m.house === "lords" ? "peer" : "mp",
          party: m.party || "Unknown", house: m.house || "commons",
          sector: cfg.sector, role: cfg.label(m),
          detail: "Auto-added from Parliament API during nightly sync — enrich and verify manually.",
          source: `Parliament API (${bodyId}), fetched ${live.fetchedAt.slice(0, 10)} — auto-added, enrich manually`,
          verified: true, autoAdded: true,
        };
        nodes.push(node);
        nodeByNorm.set(norm(m.name), node);
        drift.push(`- **NEW on ${bodyId}**: ${m.name} (${m.party || "party unknown"}) — auto-added; enrich node manually.`);
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

// Manual-layer staleness reminders (no API exists for these).
const ageDays = Math.floor((Date.now() - new Date(manual.lastVerified)) / 86400000);
if (ageDays > 30)
  drift.push(`- **Manual layers ${ageDays} days old** (last verified ${manual.lastVerified}). Check: new APPG register edition (publications.parliament.uk/pa/cm/cmallparty), GOV.UK PPS list, AFC APPG chair vacancy, new defence debates for interest cohorts.`);

// Inject
const template = readFileSync("template.html", "utf8");
const DATA = {
  builtAt: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
  nodes, memberLinks, cohorts: manual.cohorts,
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
