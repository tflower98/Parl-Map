// fetch-live.mjs — pulls machine-readable layers from Parliament's open APIs.
// Runs nightly via GitHub Actions. No dependencies (Node 20+ global fetch).
// Output: data/live.json
//
// API-covered layers: Defence Committee (24), Business & Trade Committee (365),
// MoD government posts, MoD opposition posts.
// NOT API-covered (stay in data/manual.json, human-verified): APPG register,
// PPS appointments, NATO PA delegation, debate cohorts, analytical groupings.

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const OUT = "data/live.json";
const UA = { headers: { "User-Agent": "defence-parliament-map (nightly data sync; contact via repo)" } };

const cleanName = (s) =>
  (s || "").replace(/^(Mr|Mrs|Ms|Dr|Sir|Dame|Rt Hon\.?|The Rt Hon\.?)\s+/gi, "").trim();

async function getJSON(url) {
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

// Committees API schemas have shifted before; probe common shapes.
function extractMembers(payload) {
  const items = payload.items || payload.value || payload.members || [];
  return items
    .map((m) => {
      const v = m.value || m;
      return {
        name: cleanName(v.name || v.nameDisplayAs || (v.member && v.member.name)),
        party: v.party || v.latestParty?.name || (v.member && v.member.party) || null,
        isChair: Boolean(v.isChair || (v.roles || []).some((r) => /chair/i.test(r.name || r))),
      };
    })
    .filter((m) => m.name);
}

async function committee(id) {
  // Try the documented endpoint first, then a fallback shape.
  const urls = [
    `https://committees-api.parliament.uk/api/Committees/${id}/Members?MembershipStatus=Current&take=50`,
    `https://committees-api.parliament.uk/api/committees/${id}/members?membershipStatus=Current&take=50`,
  ];
  let lastErr;
  for (const u of urls) {
    try {
      const members = extractMembers(await getJSON(u));
      if (members.length) return members;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Committee ${id}: no members extracted. Last error: ${lastErr}`);
}

async function modPosts(kind) {
  // kind: "GovernmentPosts" | "OppositionPosts"
  const data = await getJSON(`https://members-api.parliament.uk/api/Posts/${kind}`);
  const items = data.items || data.value || [];
  return items
    .map((p) => {
      const v = p.value || p;
      const holder = (v.postHolders && v.postHolders[0]) || {};
      const member = holder.member?.value || holder.member || {};
      return {
        post: v.name || v.postName,
        department: v.departments?.[0]?.name || v.departmentName || v.department || "",
        name: cleanName(member.nameDisplayAs || member.name),
        party: member.latestParty?.name || null,
        house: member.latestHouseMembership?.house === 2 ? "lords" : "commons",
      };
    })
    .filter((p) => /defence/i.test(p.department) && p.name);
}

const live = { fetchedAt: new Date().toISOString(), ok: true, errors: [] };

for (const [key, fn] of [
  ["defcom", () => committee(24)],
  ["btcom", () => committee(365)],
  ["mod", () => modPosts("GovernmentPosts")],
  ["shadow", () => modPosts("OppositionPosts")],
]) {
  try {
    live[key] = await fn();
    console.log(`${key}: ${live[key].length} records`);
  } catch (e) {
    live.ok = false;
    live.errors.push(`${key}: ${e.message}`);
    // Carry forward yesterday's data for this layer rather than emitting nothing.
    if (existsSync(OUT)) {
      const prev = JSON.parse(readFileSync(OUT, "utf8"));
      if (prev[key]) {
        live[key] = prev[key];
        live.errors.push(`${key}: carried forward previous data`);
      }
    }
    console.error(`${key} FAILED: ${e.message}`);
  }
}

writeFileSync(OUT, JSON.stringify(live, null, 1));
console.log(live.ok ? "live.json written cleanly" : `live.json written WITH ERRORS: ${live.errors.join(" | ")}`);
// Non-zero exit only if every layer failed — partial data is still useful.
if (!live.defcom && !live.btcom && !live.mod && !live.shadow) process.exit(1);
