// Builds packages/knowledge/data/openalex-frame.json: OpenAlex fields and subfields (CC0), each subfield with the
// words its research topics are known by, for matching a concept to its place (anchors spec). Run by hand, rarely:
//   node scripts/build-openalex-frame.mjs
import { writeFileSync } from "node:fs";

const API = "https://api.openalex.org";
const get = async (path) => {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};
const short = (id) => id.split("/").pop();
const all = async (kind, select) => {
  const out = [];
  for (let page = 1; ; page++) {
    const { results } = await get(`/${kind}?per-page=200&page=${page}&select=${select}`);
    out.push(...results);
    if (results.length < 200) return out;
  }
};

const fields = (await all("fields", "id,display_name,domain")).map((f) => ({ id: short(f.id), name: f.display_name, domain: f.domain.display_name }));
const subfields = (await all("subfields", "id,display_name,field")).map((s) => ({ id: short(s.id), name: s.display_name, fieldId: short(s.field.id), terms: [] }));
const bySub = new Map(subfields.map((s) => [s.id, s]));
const names = new Map(), keywords = new Map();
for (const t of await all("topics", "id,display_name,keywords,subfield")) {
  const sub = short(t.subfield.id);
  if (!bySub.has(sub)) continue;
  names.set(sub, [...(names.get(sub) ?? []), t.display_name]);
  const k = keywords.get(sub) ?? new Map();
  keywords.set(sub, k);
  for (const kw of t.keywords) k.set(kw.display_name, (k.get(kw.display_name) ?? 0) + kw.score);
}
// Each subfield keeps every topic's name, then its 30 strongest keywords (by OpenAlex's scores, summed).
for (const s of subfields) {
  const best = [...(keywords.get(s.id) ?? new Map())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30).map(([t]) => t);
  s.terms = [...new Set([...(names.get(s.id) ?? []).sort(), ...best])];
}
fields.sort((a, b) => a.name.localeCompare(b.name));
subfields.sort((a, b) => a.name.localeCompare(b.name));
const out = { source: "OpenAlex (https://openalex.org), CC0", builtAt: new Date().toISOString().slice(0, 10), fields, subfields };
writeFileSync(new URL("../packages/knowledge/data/openalex-frame.json", import.meta.url), `${JSON.stringify(out)}\n`);
console.log(`${fields.length} fields, ${subfields.length} subfields`);
