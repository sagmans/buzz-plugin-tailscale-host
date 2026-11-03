// buzz-runner entry point: load and validate config (fail fast), prepare the
// state tree, start the agents, then serve the plugin API on its Unix socket. SIGTERM
// and SIGINT stop the server, every listener and every claude process within
// a deadline, so systemd restarts never leave orphans holding a session.
import { AgentManager } from "./agents";
import { configPath, loadConfig } from "./config";
import { SHUTDOWN_DEADLINE_MS, VERSION } from "./constants";
import { createApi } from "./http";
import { log, setLevel } from "./log";
import { installFetchDeadline } from "./net";
import { checkSocket, listenSocket } from "./socket";
import { StateStore } from "./store";

const EXIT_CONFIG = 78; // EX_CONFIG: systemd shows a config fault, not a crash
const EXIT_FAILURE = 1;

async function main() {
  const config = loadConfig(configPath(process.argv.slice(2), process.env));
  setLevel(config.logLevel);
  installFetchDeadline();
  const store = new StateStore(config.stateDir);
  store.init();
  const agents = new AgentManager(config, store, log.child({ component: "agents" }));
  const server = createApi(config, agents, log.child({ component: "http" }));
  // A bad socket directory stops the start before any agent connects to its
  // relay; the API opens only once every record is loaded, so provision's
  // idempotency and limits see them all.
  await checkSocket(config.socket);
  await agents.start();
  await listenSocket(server, config.socket);
  log.info("runner listening", { version: VERSION, socket: config.socket });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("runner stopping", { signal });
    const forced = setTimeout(() => {
      log.error("shutdown deadline passed; exiting", { deadlineMs: SHUTDOWN_DEADLINE_MS });
      process.exit(EXIT_FAILURE);
    }, SHUTDOWN_DEADLINE_MS);
    forced.unref();
    server.close();
    server.closeAllConnections();
    await agents.shutdown();
    log.info("runner stopped");
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

process.on("unhandledRejection", (error) => log.error("unhandled rejection", { error }));

/** Reused buzz-app modules report through `console` (typing gives up with
 * `console.warn`). journald and the smoke expect JSON lines only, so those
 * calls go to the structured logger. Only a leading string and Error
 * arguments are kept: other arguments could carry event content. */
function routeConsole() {
  const library = log.child({ component: "library" });
  const fields = (args: unknown[]) => ({
    ...(typeof args[0] === "string" ? { detail: args[0] } : {}),
    ...(args.find((arg) => arg instanceof Error) ? { error: args.find((arg) => arg instanceof Error) } : {}),
  });
  console.log = (...args: unknown[]) => library.info("library message", fields(args));
  console.info = console.log;
  console.debug = (...args: unknown[]) => library.debug("library message", fields(args));
  console.warn = (...args: unknown[]) => library.warn("library warning", fields(args));
  console.error = (...args: unknown[]) => library.error("library error", fields(args));
}
routeConsole();

main().catch((error) => {
  log.error("runner failed to start", { error });
  process.exit(error?.code === "config_invalid" ? EXIT_CONFIG : EXIT_FAILURE);
});
