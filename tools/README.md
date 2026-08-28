# tools/ — local verify & HTTP tooling

Source `.mjs` run by `node`, **outside `src/`** on purpose: `tsconfig` has
`rootDir: ./src`, and the Dockerfile copies only `src -> dist` (plus
`dashboard/public`), so nothing here is compiled by `tsc` or shipped in the
deployed harness image. That is what makes the cross-repo import of the shared
vault safe here but wrong in `src/`.

## `tools/http/http-json.mjs` (P5)

`httpJson(url, opts)` — the default JSON client. Sends a browser User-Agent by
default (fixes Cloudflare 1010) and takes a pluggable success verdict:

- `statusSuccess` (default) — pure 2xx. What GHL and ordinary APIs need.
- `datasphereSuccess` (opt-in) — a faithful port of
  `pipeline/tbfc/datasphere.py:interpret_response`; a 200 that is really a
  body-level rejection (`{"event":"Missing key ..."}`) is reported as a failure.

Transport never throws (timeout/network → `status:0`); request headers never
surface in the return value. Pure + `fetchImpl`-injectable → hermetic tests.

## `tools/verify/` (P4)

"Prove it by live read" as a library, seeded from the TBFC ad-hoc scripts:

- `ghl.inventory({locationId, secretName|token})` — READ-ONLY sub-account
  inventory (location, custom values/fields, tags, pipelines, workflows).
- `ghl.upsertField({locationId, field, secretName|token, guard?})` — idempotent
  create-if-missing, always read-back verified, **never deletes**, refuses
  offer-shaped names before any network call.
- `datasphere.campaignState({secretName|token, state?})` — campaigns + run state,
  using the body-level success rule.

Each reads its secret by NAME via the shared vault's `getSecretFast` (P1), or
takes a pre-resolved `token`. Every function accepts an injected `http` so tests
run offline. `_vault.mjs` holds the one cross-repo path (lazy import).

`cloudrun.revisionReady()` is a deliberate follow-up slice — its auth path
overlaps the P6 deploy helper (`run services list --filter`, never `describe`).

Run: `node --test checks/verify-lib.test.mjs tools/http/http-json.test.mjs`
(both are also in `npm test`).
