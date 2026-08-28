/**
 * The ONE place that names the cross-repo path to the shared vault. A tree move
 * edits this line only. The import is LAZY (dynamic) so the verify modules load
 * even where the vault's own dependency (@google-cloud/secret-manager) or its
 * node_modules is absent — a test that injects a `token` never triggers it.
 *
 * Depth: verify -> tools -> ds-build-agent -> internal-tools -> portfolios ->
 * Projects, then _tools/vault. That is exactly five `..`.
 */
export async function getSecretFast(secretName, opts) {
  const mod = await import("../../../../../_tools/vault/vault.mjs");
  return mod.getSecretFast(secretName, opts);
}
