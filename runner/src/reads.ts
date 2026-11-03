// What a turn reads of its community as the agent, mirroring the parts of
// Desktop's `AgentReads` that the Claude runtime uses: a channel's name and
// kind, its roster, thread context, and display names. All reads go through
// the agent's own `nodeClient`, so the relay applies the agent's access.
import type { BuzzClient, BuzzEvent } from "@buzz/buzz-mcp/client";
import { soloChannelMetadata } from "@buzz/features/relay/discovery";
import type { RelayEvent } from "@buzz/features/relay/events";
import { HEX64, KIND_CHANNEL_MEMBERS, KIND_CHANNEL_METADATA, KIND_PROFILE, NIP11_TIMEOUT_MS } from "./constants";
import { RelayError } from "./errors";

export type ChannelSummary = Readonly<{
  id: string;
  name?: string;
  /** "solo" | "dm" | "stream" | "forum" | "system" | undefined, as Desktop's
   * DiscoveryState derives it. */
  channelType?: string;
  members: readonly string[];
}>;

const tag = (event: Pick<BuzzEvent, "tags">, name: string) => event.tags.find((item) => item[0] === name)?.[1];

/** Desktop `metadataName`: the JSON body's name, else the `name` tag. */
function metadataName(event: BuzzEvent) {
  try {
    const body = JSON.parse(event.content) as { name?: unknown };
    if (typeof body?.name === "string" && body.name) return body.name;
  } catch {
    // Metadata content is optional JSON; the tag is the fallback.
  }
  return tag(event, "name") || undefined;
}

export function rosterMembers(roster: BuzzEvent | undefined) {
  return [
    ...new Set(
      (roster?.tags ?? []).flatMap(([name, value]) => (name === "p" && value && HEX64.test(value) ? [value] : [])),
    ),
  ].sort();
}

/** The relay's signing key from its NIP-11 document, which is the only
 * author trusted for channel metadata and rosters (as Desktop's discovery
 * and buzz-acp `relay_self` require). Undefined when the relay names none. */
export async function relaySelf(community: string): Promise<string | undefined> {
  const base = community.replace(/^ws/, "http").replace(/\/+$/, "");
  const response = await fetch(`${base}/`, {
    headers: { accept: "application/nostr+json" },
    signal: AbortSignal.timeout(NIP11_TIMEOUT_MS),
    redirect: "error",
  }).catch((cause) => {
    throw new RelayError("NIP-11 document unavailable", { cause });
  });
  if (!response.ok) throw new RelayError(`NIP-11 document returned ${response.status}`);
  const document = (await response.json().catch(() => ({}))) as { self?: unknown };
  return typeof document.self === "string" && HEX64.test(document.self) ? document.self : undefined;
}

export class CommunityReads {
  constructor(
    private readonly client: BuzzClient,
    /** Relay key from NIP-11; without it no metadata is trusted. */
    private readonly relayAuthor: () => string | undefined,
  ) {}

  /** The channel as Desktop summarizes it. Metadata not signed by the relay
   * is ignored, so an unverifiable channel reads as an ordinary thread. */
  async channel(id: string): Promise<ChannelSummary> {
    const author = this.relayAuthor();
    if (!author) return { id, members: [] };
    const [metadata, roster] = await Promise.all([
      this.client.query([{ kinds: [KIND_CHANNEL_METADATA], "#d": [id], authors: [author], limit: 1 }]),
      this.client.query([{ kinds: [KIND_CHANNEL_MEMBERS], "#d": [id], authors: [author], limit: 1 }]),
    ]);
    const event = metadata.find((item) => item.pubkey === author);
    const members = rosterMembers(roster.find((item) => item.pubkey === author));
    const type = event
      ? soloChannelMetadata(event as unknown as RelayEvent)
        ? "solo"
        : tag(event, "t")
      : undefined;
    const name = event && metadataName(event);
    return {
      id,
      ...(name ? { name } : {}),
      ...(type ? { channelType: type } : {}),
      members,
    };
  }

  read(filters: readonly Record<string, unknown>[]) {
    return this.client.query(filters);
  }

  /** Display names for pubkeys, from their kind-0 profiles. */
  async names(pubkeys: readonly string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const wanted = pubkeys.filter((pubkey) => HEX64.test(pubkey));
    if (!wanted.length) return names;
    const profiles = await this.client.query([{ kinds: [KIND_PROFILE], authors: wanted, limit: wanted.length }]);
    for (const profile of profiles) {
      try {
        const body = JSON.parse(profile.content) as { display_name?: unknown; name?: unknown };
        const name =
          (typeof body.display_name === "string" && body.display_name.trim()) ||
          (typeof body.name === "string" && body.name.trim());
        if (name && !names.has(profile.pubkey)) names.set(profile.pubkey, name);
      } catch {
        // A profile with unreadable content simply has no name.
      }
    }
    return names;
  }
}
