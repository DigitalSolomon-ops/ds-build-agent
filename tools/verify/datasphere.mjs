/**
 * DataSphere live-read/verify helpers — the reusable version of the campaign read
 * in pipeline/tbfc/datasphere.py. Local verify tooling (outside src/). Uses the P5
 * httpJson client with the datasphereSuccess rule, so a 200 that is really a
 * body-level rejection ({"event":"Missing key ..."}) is reported as a failure.
 *
 * DataSphere quirks baked in via httpJson: the api_key goes in the BODY (never a
 * header), all endpoints are POST, and a browser UA is required (Cloudflare 1010).
 */
import { httpJson, datasphereSuccess } from "../http/http-json.mjs";
import { getSecretFast } from "./_vault.mjs";

const BASE = "https://myapiconnect.com/api-product/incoming-webhook";
const ENDPOINT_FETCH_CAMPAIGNS = "fetch-all-campaigns";

/** Re-exported so callers can reuse the exact success predicate. */
export { datasphereSuccess } from "../http/http-json.mjs";

async function resolveApiKey(opts) {
  if (opts.token) return opts.token;
  if (!opts.secretName) {
    throw new Error("datasphere: pass a `token` (api_key) or a `secretName`.");
  }
  return getSecretFast(opts.secretName, { project: opts.project, version: opts.version });
}

/**
 * Read the campaigns and their run state. A read, but POST per the API contract.
 * @param {{ state?:"running"|"paused"|"all", secretName?:string, token?:string,
 *   project?:string, version?:string, http?:typeof httpJson }} opts
 * @returns {Promise<{ ok:boolean, status:number, detail:string, campaigns:any[] }>}
 */
export async function campaignState(opts = {}) {
  const { state, http = httpJson } = opts;
  const apiKey = await resolveApiKey(opts);
  const body = { api_key: apiKey };
  if (state) body.state = state;
  const r = await http(`${BASE}/${ENDPOINT_FETCH_CAMPAIGNS}`, {
    method: "POST",
    body,
    isSuccess: datasphereSuccess,
  });
  return {
    ok: r.ok,
    status: r.status,
    detail: r.detail,
    campaigns: Array.isArray(r.parsed) ? r.parsed : [],
  };
}

export const _config = { BASE, ENDPOINT_FETCH_CAMPAIGNS };
