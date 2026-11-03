// Publishing without the owner's NIP-OA tag.
//
// Used only when `attestEvents` is false. Buzz Desktop wakes its agents on
// any event that carries a valid owner `auth` tag (buzz-app
// owner-attestation.ts `fromOwner`), so untagged messages keep hosted agents
// from waking the owner's desktop agents. The tag then goes only where relay
// membership needs it: the kind-0 profile, the NIP-42 AUTH event and the
// `x-auth-tag` header of every REST call.
//
// buzz-app's `nodeClient.publish` always appends the tag and buzz-app is not
// edited here, so this module re-implements only that one method. The method
// follows nodeClient's (buzz-app src/buzz-mcp; Apache-2.0, Copyright 2026
// Block, Inc.; see NOTICE). Everything else (queries, memory encryption to
// the owner, media, uploads) stays nodeClient's own, with the tag still sent
// as the membership header.
import { createHash, randomUUID } from "node:crypto";
import type { BuzzClient, BuzzEvent, Template } from "@buzz/buzz-mcp/client";
import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import { KIND_PROFILE } from "./constants";
import { RelayError } from "./errors";

/** NIP-98 HTTP auth (kind 27235), as nodeClient signs it. */
const KIND_HTTP_AUTH = 27235;
/** nodeClient adds `ms` (sub-second order) to channel events; kept so both
 * paths order messages alike. */
const MS_PER_S = 1000;
/** A refusal body is read only this far. */
const REFUSAL_MAX = 300;
/** The relay treats a re-sent event as success, as nodeClient does. */
const DUPLICATE = "duplicate";

const now = () => Math.floor(Date.now() / MS_PER_S);
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

export type PublishTarget = Readonly<{
  /** Community relay URL (wss://…); REST lives at the same host over https. */
  relay: string;
  /** Agent secret key, hex. Used only to sign, inside this process. */
  key: string;
  /** Owner's NIP-OA tag as JSON, for the membership header only. */
  auth?: string;
}>;

/** `client` with `publish` replaced: no `auth` tag, except on kind 0. */
export function withoutAttestation(client: BuzzClient, target: PublishTarget): BuzzClient {
  const secret = hexToBytes(target.key);
  const base = target.relay.replace(/^ws/, "http").replace(/\/+$/, "");
  const sign = (template: Template) =>
    finalizeEvent(
      { kind: template.kind, content: template.content, tags: template.tags.map((tag) => [...tag]), created_at: now() },
      secret,
    ) as BuzzEvent;

  async function post(event: BuzzEvent) {
    const url = `${base}/events`;
    const body = JSON.stringify(event);
    const proof = sign({
      kind: KIND_HTTP_AUTH,
      content: "",
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", sha256(body)],
        ["nonce", randomUUID()],
      ],
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Nostr ${Buffer.from(JSON.stringify(proof)).toString("base64")}`,
        "content-type": "application/json",
        ...(target.auth ? { "x-auth-tag": target.auth } : {}),
      },
      body,
      redirect: "error",
    });
    const text = await response.text();
    if (!response.ok) throw new RelayError(`Publish failed: ${response.status} ${text.slice(0, REFUSAL_MAX)}`.trim());
    let reply: { accepted?: boolean; message?: string };
    try {
      reply = JSON.parse(text) as typeof reply;
    } catch (cause) {
      throw new RelayError("Publish reply is not JSON", { cause });
    }
    if (!reply.accepted && !reply.message?.startsWith(DUPLICATE))
      throw new RelayError(reply.message || "The community refused the event");
    return event;
  }

  return {
    ...client,
    publish(event) {
      // The profile keeps the tag: Desktop and the relay read agent
      // ownership from it, and a profile wakes no one.
      if (event.kind === KIND_PROFILE) return client.publish(event);
      const tags = event.tags.filter((tag) => tag[0] !== "auth" && tag[0] !== "ms");
      if (tags.some((tag) => tag[0] === "h")) tags.push(["ms", String(Date.now() % MS_PER_S)]);
      return post(sign({ ...event, tags }));
    },
  };
}
