// Structured JSON-lines logger. journald keeps stdout, so one JSON object per
// line is all the runner needs. Field names that could carry key material,
// owner proofs, logins or message text are redacted here as a last line of
// defense: callers already avoid passing them, and this catches a mistake.
import { LOG_PUBKEY_CHARS } from "./constants";

export const LEVELS = ["debug", "info", "warn", "error"] as const;
export type Level = (typeof LEVELS)[number];
type Fields = Readonly<Record<string, unknown>>;

/** Any field whose name matches is never written. `content` and `text`
 * cover message bodies, which are personal data. `auth` and `sig` match only
 * as whole names (or authTag/authorization/signature), so `author`,
 * `authenticated` and `signal` stay readable. */
const REDACT =
  /secret|private|nsec|seckey|^auth$|authtag|authorization|^sig$|signature|token|password|login|cookie|content|text|prompt/i;
const REDACTED = "[redacted]";
const CAUSE_DEPTH = 5;

let threshold: number = LEVELS.indexOf("info");
let sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`);

export function setLevel(level: Level) {
  threshold = LEVELS.indexOf(level);
}
/** Lets the smoke harness or a test capture lines; production keeps stdout. */
export function setSink(next: (line: string) => void) {
  sink = next;
}

/** A pubkey as logs show it: enough to tell agents apart, never a full key. */
export const short = (pubkey: string | undefined) =>
  pubkey ? pubkey.slice(0, LOG_PUBKEY_CHARS) : undefined;

/** An error and its causes, without stack frames that may embed inputs. */
export function describeError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === "string" ? { code } : {}),
    ...(error.cause !== undefined && depth < CAUSE_DEPTH
      ? { cause: describeError(error.cause, depth + 1) }
      : {}),
  };
}

function scrub(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return describeError(value);
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      REDACT.test(key) ? REDACTED : scrub(item, depth + 1),
    ]),
  );
}

function write(level: Level, msg: string, fields: Fields = {}) {
  if (LEVELS.indexOf(level) < threshold) return;
  try {
    sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg,
        ...(scrub(fields) as Fields),
      }),
    );
  } catch {
    // A log line must never take the runner down (EPIPE on a closed stdout).
  }
}

export type Logger = Readonly<{
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}>;

/** A logger whose lines all carry `base`, such as the agent they concern. */
export function logger(base: Fields = {}): Logger {
  const at =
    (level: Level) =>
    (msg: string, fields: Fields = {}) =>
      write(level, msg, { ...base, ...fields });
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (fields) => logger({ ...base, ...fields }),
  };
}

export const log = logger({ component: "runner" });
