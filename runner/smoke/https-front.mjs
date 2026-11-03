// Local HTTPS stand-ins for `tailscale serve` on a host, for the plugin
// smoke. The plugin's hosts helper reaches a host only by an https:// origin
// from hosts.json, as on a real tailnet, so the smoke serves each test host
// over TLS on the loopback address with a throwaway certificate. The helper
// trusts that certificate through NODE_EXTRA_CA_CERTS, the way the user's
// node trusts the certificate that `tailscale serve` gets.
import { execFile } from "node:child_process";
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
/** The loopback address the fronts listen on; the certificate names it. */
export const FRONT_HOST = "127.0.0.1";
/** openssl only makes a key and a self-signed certificate here; bounded so a
 * stuck tool cannot hold the smoke. */
const OPENSSL_TIMEOUT_MS = 30_000;
/** Valid for the run only. */
const CERT_DAYS = 1;
/** Request bodies the runner takes are small; a larger one is a bug. */
const BODY_MAX = 1_048_576;

/** Makes a key and a self-signed certificate for FRONT_HOST in `dir`;
 * returns their paths. Fails closed when openssl is missing. */
export async function makeCertificate(dir) {
  const key = join(dir, "front-key.pem");
  const cert = join(dir, "front-cert.pem");
  await run(
    "openssl",
    ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", String(CERT_DAYS), "-subj", `/CN=${FRONT_HOST}`, "-addext", `subjectAltName=IP:${FRONT_HOST}`],
    { timeout: OPENSSL_TIMEOUT_MS },
  );
  return { key, cert };
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_MAX) throw new Error(`front: request body over ${BODY_MAX} bytes`);
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
}

/**
 * Starts one HTTPS front on a free port.
 * @param {{key: string, cert: string}} tls
 * @param {(call: {method: string, path: string, body?: string, headers: object}) => Promise<{status: number, body?: string, headers?: object} | "drop">} handle
 *   "drop" closes the connection without an answer, as a host that is down.
 * @returns {Promise<{origin: string, close: () => Promise<void>}>}
 */
export async function startFront(tls, handle) {
  const server = createServer({ key: readFileSync(tls.key), cert: readFileSync(tls.cert) }, async (request, response) => {
    try {
      const body = await readBody(request);
      const answer = await handle({ method: request.method, path: request.url, body, headers: request.headers });
      if (answer === "drop") {
        request.socket.destroy();
        return;
      }
      response.writeHead(answer.status, { "content-type": "application/json", ...(answer.headers ?? {}) });
      response.end(answer.body ?? "");
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "front", message: String(error?.message ?? error) }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, FRONT_HOST, resolve);
  });
  const { port } = server.address();
  return {
    origin: `https://${FRONT_HOST}:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
