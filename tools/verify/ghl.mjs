/**
 * GHL live-read/verify helpers — the reusable version of the TBFC ad-hoc scripts
 * (ghl-inventory.mjs, ghl-create-fields.mjs). Local verify tooling: run by node,
 * never bundled into the deployed harness (it lives outside src/). Reads the
 * location token by NAME via the shared vault (P1 getSecretFast) or takes a
 * pre-resolved token; sends every request through the P5 httpJson client.
 *
 * Laws inherited from the tree and from vault.mjs:
 *   - Never logs, returns, or embeds a token/secret in output.
 *   - upsertField is CREATE-ONLY and idempotent (read-back verified). No delete path.
 *   - An offer-shaped field name is refused before any network call.
 */
import { httpJson, statusSuccess } from "../http/http-json.mjs";
import { getSecretFast } from "./_vault.mjs";

const API = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

/** GHL fieldKey -> bare key (drop the `contact.` prefix the API adds). */
const stripPrefix = (fk) => String(fk || "").replace(/^contact\./, "");
/** Field name -> the key GHL derives from it (must match stripPrefix on read-back). */
const keyOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
/** Reject anything that reads like a financing figure (mirrors ghl-create-fields.mjs). */
const OFFER = /\b(rate|apr|factor|payoff|payment|term|offer|amount|funded|advance|monetory)\b/i;

async function resolveToken(opts) {
  if (opts.token) return opts.token;
  if (!opts.secretName) {
    throw new Error("ghl: pass a `token` or a `secretName` (a Secret Manager name).");
  }
  return getSecretFast(opts.secretName, { project: opts.project, version: opts.version });
}

const authHeaders = (token) => ({ Authorization: `Bearer ${token}`, Version: VERSION });
const fmt = (arr, nameKey = "name", idKey = "id") =>
  Array.isArray(arr) ? arr.map((x) => `${x[nameKey] ?? x.key ?? "?"}  [${x[idKey] ?? "?"}]`) : [];

/**
 * READ-ONLY inventory of a GHL sub-account: location read-back plus custom
 * values, custom fields, tags, pipelines, and workflows. Ports ghl-inventory.mjs.
 * @param {{ locationId:string, secretName?:string, token?:string, project?:string,
 *   version?:string, http?:typeof httpJson }} opts
 */
export async function inventory(opts = {}) {
  const { locationId, http = httpJson } = opts;
  if (!locationId) throw new Error("ghl.inventory: locationId is required.");
  const headers = authHeaders(await resolveToken(opts));
  const get = (path) => http(`${API}${path}`, { headers, isSuccess: statusSuccess });

  const out = { locationId };
  const loc = await get(`/locations/${locationId}`);
  const locObj = loc.parsed?.location ?? loc.parsed;
  out.location = loc.ok
    ? { status: loc.status, id: locObj?.id, name: locObj?.name, matchesId: locObj?.id === locationId }
    : { status: loc.status, error: (loc.text || "").slice(0, 300) };

  const endpoints = [
    ["customValues", `/locations/${locationId}/customValues`, "customValues"],
    ["customFields", `/locations/${locationId}/customFields`, "customFields"],
    ["tags", `/locations/${locationId}/tags`, "tags"],
    ["pipelines", `/opportunities/pipelines?locationId=${locationId}`, "pipelines"],
    ["workflows", `/workflows/?locationId=${locationId}`, "workflows"],
  ];
  for (const [key, path, listKey] of endpoints) {
    const r = await get(path);
    if (!r.ok) {
      out[key] = { status: r.status, error: (r.text || "").slice(0, 300) };
      continue;
    }
    const list = r.parsed?.[listKey] ?? r.parsed?.[key] ?? (Array.isArray(r.parsed) ? r.parsed : []);
    out[key] = { status: r.status, count: Array.isArray(list) ? list.length : "?", items: fmt(list) };
  }
  return out;
}

/**
 * Idempotent create-if-missing of ONE custom field, always read-back verified.
 * Ports the core of ghl-create-fields.mjs. Never deletes. Refuses offer-shaped
 * names before any network call.
 * @param {{ locationId:string, field:{name:string,dataType:string,options?:any[]},
 *   secretName?:string, token?:string, project?:string, version?:string,
 *   guard?:(field:object)=>void, http?:typeof httpJson }} opts
 */
export async function upsertField(opts = {}) {
  const { locationId, field, http = httpJson, guard } = opts;
  if (!locationId) throw new Error("ghl.upsertField: locationId is required.");
  if (!field || !field.name || !field.dataType) {
    throw new Error("ghl.upsertField: field.name and field.dataType are required.");
  }
  // Guards run BEFORE any network call — offer-shape first, then any caller guard.
  if (OFFER.test(field.name) || field.dataType === "MONETORY") {
    throw new Error(`ghl.upsertField: refusing offer-shaped field: ${field.name} (${field.dataType})`);
  }
  if (guard) guard(field);

  const headers = authHeaders(await resolveToken(opts));
  const listPath = `/locations/${locationId}/customFields`;
  const key = keyOf(field.name);

  const existingRes = await http(`${API}${listPath}`, { headers, isSuccess: statusSuccess });
  if (!existingRes.ok) {
    throw new Error(`ghl.upsertField: list failed ${existingRes.status}: ${(existingRes.text || "").slice(0, 200)}`);
  }
  const byKey = new Map((existingRes.parsed?.customFields || []).map((f) => [stripPrefix(f.fieldKey), f]));
  if (byKey.has(key)) {
    const have = byKey.get(key);
    return {
      name: field.name, dataType: field.dataType, status: "exists",
      id: have.id, fieldKey: have.fieldKey,
      readback: { id: have.id, name: have.name, dataType: have.dataType },
    };
  }

  const createRes = await http(`${API}${listPath}`, { method: "POST", headers, body: field, isSuccess: statusSuccess });
  if (!createRes.ok) {
    throw new Error(`ghl.upsertField: create failed ${createRes.status}: ${(createRes.text || "").slice(0, 200)}`);
  }
  const cf = createRes.parsed?.customField || createRes.parsed || {};

  const afterRes = await http(`${API}${listPath}`, { headers, isSuccess: statusSuccess });
  const back = new Map((afterRes.parsed?.customFields || []).map((f) => [stripPrefix(f.fieldKey), f])).get(key);
  return {
    name: field.name, dataType: field.dataType, status: "created",
    id: cf.id, fieldKey: cf.fieldKey,
    readback: back ? { id: back.id, name: back.name, dataType: back.dataType } : null,
  };
}

export const _config = { API, VERSION, keyOf, stripPrefix };
