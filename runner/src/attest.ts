// NIP-OA owner proof checks at activation. The signature check itself is
// buzz-app's `authTagOwner`, the same code Desktop uses to read attested
// events, so the runner accepts exactly the tags Desktop would trust.
import { authTagOwner } from "@buzz/features/agents/owner-attestation";
import { HEX128, HEX64 } from "./constants";
import { AttestationError } from "./errors";

export type AuthTag = readonly ["auth", string, string, string];

/** Shape check at the HTTP boundary, before any crypto runs. */
export function parseAuthTag(value: unknown): AuthTag {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value[0] !== "auth" ||
    typeof value[1] !== "string" ||
    !HEX64.test(value[1]) ||
    value[2] !== "" ||
    typeof value[3] !== "string" ||
    !HEX128.test(value[3])
  )
    throw new AttestationError('auth must be ["auth", <owner hex>, "", <sig hex>]');
  return value as unknown as AuthTag;
}

/** The tag must name the configured owner and carry a valid BIP-340
 * signature by that owner over sha256("nostr:agent-auth:<agent>:"). The
 * runner's contract allows only unconditional proofs (empty conditions). */
export async function verifyOwnerProof(tag: AuthTag, agent: string, owner: string) {
  if (tag[1] !== owner) throw new AttestationError("auth names a different owner");
  if ((await authTagOwner(agent, tag)) !== owner)
    throw new AttestationError("auth signature does not verify for this agent");
}
