// fetch-live.mjs — pulls machine-readable layers from Parliament's open APIs.
// Schema for Posts endpoints verified against members-api.parliament.uk
// swagger v1 (bare array of GovernmentOppositionPostItem). Committees API
// extraction is multi-shape tolerant and logs the raw payload on mismatch.
// This script never exits non-zero: failures are recorded in live.json and
// surfaced by build.mjs in the drift report.

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const OUT = "data/live.json";
const UA = { headers: { "User-Agent": "parl-map nightly sync (contact via repo)", "Accept": "application/json" } };

const cleanName = (s) =>
  (s || "").replace(/\b(Mr|Mrs|Ms|Dr|Sir|Dame|Rt Hon\.?|The Rt Hon\.?)\b\.?\s*/gi, "").trim();

async function getJSON(url) {
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

/* ---------- Committees API ---------- */
function extractCommitteeMembers(payload) {
  const items = Array.isArray(payload) ? payload : payload.items || payload.value || payload.members || [];
  const out = items
    .map((raw) => {
      const m = raw.value || raw;
      const person = m.member?.value || m.member || m.memberInfo || m;
      const name = cleanName(person.name || person.nameDisplayAs || m.name || m.nameDisplayAs);
      const party = person.latestParty?.name || person.party || m.party || null;
      const roles = m.roles || m.committeeRoles || [];
      const isChair = Boolean(m.isChair || roles.some((r) => /chair/i.test(r.name || r.role || String(r))));
      return name ? { name, party, isChair } : null;
    })
    .filter(Boolean);
  if (!out.length && items.length) {
    console.error("Committee payload shape unrecognised. Sample:", JSON.stringify(items[0]).slice(0, 800));
  }
  return out;
}

async function committee(id) {
  const urls = [
    `https://committees-api.parliament.uk/api/Committees/${id}/Members?MembershipStatus=Current&take=50`,
    `https://committees-api.parliament.uk/api/committees/${id}/members?membershipStatus=Current&take=50`,
  ];
  let lastErr;
  for (const u of urls) {
    try {
      const members = extractCommitteeMembers(await getJSON(u));
      if (members.length) return members;
      lastErr = new Error("payload extracted to zero members");
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Committee ${id}: ${lastErr}`);
}

/* ---------- Members API Posts (schema verified vs swagger) ---------- */
async function modPosts(kind) {
  const payload = await getJSON(`https://members-api.parliament.uk/api/Posts/${kind}`);
  const items = Array.isArray(payload) ? payload : payload.items || [];
  const out = [];
  for (const item of items) {
    const post = item.value || item; // GovernmentOppositionPost
    const depts = post.governmentDepartments || [];
    if (!depts.some((d) => /defence/i.test(d.name || ""))) continue;
    const holders = (post.postHolders || []).filter((h) => !h.endDate);
    const holder = holders[0] || (post.postHolders || [])[0];
    if (!holder) continue;
    const member = holder.member?.value || holder.member || {};
    const name = cleanName(member.nameDisplayAs || member.nameListAs || member.name);
    if (!name) continue;
    out.push({
      post: post.name,
      department: depts.map((d) => d.name).join("; "),
      name,
      party: member.latestParty?.name || null,
      house: member.latestHouseMembership?.house === 2 ? "lords" : "commons",
    });
  }
  if (!out.length && items.length) {
    console.error(`${kind}: no Defence posts extracted from ${items.length} items. Sample:`, JSON.stringify(items[0]).slice(0, 800));
  }
  return out;
}

/* ---------- run ---------- */
const live = { fetchedAt: new Date().toISOString(), ok: true, errors: [] };

for (const [key, fn] of [
  ["defcom", () => committee(24)],
  ["btcom", () => committee(365)],
  ["mod", () => modPosts("GovernmentPosts")],
  ["shadow", () => modPosts("OppositionPosts")],
]) {
  try {
    const rows = await fn();
    if (!rows.length) throw new Error("zero rows extracted");
    live[key] = rows;
    console.log(`${key}: ${rows.length} records`);
  } catch (e) {
    live.ok = false;
    live.errors.push(`${key}: ${e.message}`);
    if (existsSync(OUT)) {
      try {
        const prev = JSON.parse(readFileSync(OUT, "utf8"));
        if (prev[key]?.length) { live[key] = prev[key]; live.errors.push(`${key}: carried forward previous data`); }
      } catch {}
    }
    console.error(`${key} FAILED: ${e.message}`);
  }
}

writeFileSync(OUT, JSON.stringify(live, null, 1));
console.log(live.ok ? "live.json written cleanly" : `live.json written WITH ERRORS: ${live.errors.join(" | ")}`);
