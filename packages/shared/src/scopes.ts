import { z } from "zod";

/**
 * What an API credential may do, independent of who holds it.
 *
 * Three scopes, matched to the three postures an external client can take
 * toward the approval loop:
 *
 *  - `read`     look: the inbox, accounts, analytics, memory, the audit trail.
 *  - `propose`  add work that a human will still review: propose a post,
 *               send one back with feedback.
 *  - `approve`  decide: approve or reject pending items. This is the human
 *               gate itself, so it is never implied — a key only carries it
 *               when someone chose that at mint time.
 *
 * Granting the agent autonomy is deliberately not a scope. That decision must
 * trace to a person (see `isUserBacked`), because a standing credential that
 * can widen its own permissions is an escalation path, not a scope.
 */
export const API_SCOPES = ["read", "propose", "approve"] as const;

export const apiScopeSchema = z.enum(API_SCOPES);
export type ApiScope = z.infer<typeof apiScopeSchema>;

/**
 * Interpret a key's stored scope list, including history.
 *
 * Keys minted before scopes were enforced carry `["read", "write"]` (or, from
 * even earlier hand inserts, nothing at all). Those keys were full-power in
 * practice, and narrowing them silently would break running integrations — so
 * `write` and the empty list both map to every scope. New keys store the
 * literal scopes they were minted with.
 */
export function normalizeScopes(raw: readonly string[] | null | undefined): Set<ApiScope> {
  if (!raw || raw.length === 0) return new Set(API_SCOPES);

  const scopes = new Set<ApiScope>();
  for (const value of raw) {
    if (value === "write") {
      scopes.add("propose");
      scopes.add("approve");
    } else if ((API_SCOPES as readonly string[]).includes(value)) {
      scopes.add(value as ApiScope);
    }
    // Unknown values are ignored rather than fatal: a key must never gain
    // power from a typo, and must never stop authenticating because of one.
  }
  scopes.add("read");
  return scopes;
}
