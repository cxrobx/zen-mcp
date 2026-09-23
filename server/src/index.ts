#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { parseArgs } from "./cli.js";
import { DaemonClient, RpcError } from "./daemon-client.js";
import { type ScopeRef, applySessionDefault, containerInstructions, registerTools } from "./tools.js";
import { NavContext } from "./nav-memory.js";
import { loadRouteTable } from "./routes.js";

const SERVER_NAME = "zen-ext-mcp";
const SERVER_VERSION = "0.0.4";

function logStderr(msg: string, fields?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), source: "server", message: msg, ...fields };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

function readToken(path: string): string {
  return readFileSync(path, "utf8").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(daemon: DaemonClient, url: string): Promise<void> {
  let delayMs = 500;
  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await daemon.connect();
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      logStderr("daemon connect failed; retrying", {
        url,
        attempt,
        nextDelayMs: delayMs,
        err: (err as Error).message,
      });
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 10_000);
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const token = readToken(opts.tokenPath);
  const url = `ws://${opts.host}:${opts.port}`;

  // The working directory is the session's: a project directory in the route table picks
  // the default container, and --container covers every session started anywhere else.
  const scope: ScopeRef = { current: null, requestedName: null, flagName: opts.container };
  applySessionDefault(scope, loadRouteTable(), process.cwd());

  const daemon = new DaemonClient({
    url,
    token,
    containerScope: scope.requestedName ?? null,
  });
  await connectWithRetry(daemon, url);
  logStderr("connected to daemon", { url, container: scope.requestedName ?? null });
  if (scope.requestedName) {
    logStderr("container scope deferred", { name: scope.requestedName, source: scope.source });
  }

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: containerInstructions(scope) },
  );
  const nav = new NavContext(daemon, process.env.ZEN_MCP_NAV_MEMORY !== "0");
  registerTools(server, daemon, scope, {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    daemonUrl: url,
  }, nav);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logStderr("mcp server ready", { name: SERVER_NAME, version: SERVER_VERSION });

  const cleanup = async () => {
    daemon.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void cleanup());
  process.on("SIGINT", () => void cleanup());
  process.stdin.on("end", () => void cleanup());
  process.stdin.on("close", () => void cleanup());
}

main().catch((err) => {
  if (err instanceof RpcError) {
    logStderr("rpc error", { code: err.code, message: err.message });
  } else {
    logStderr("fatal", { err: (err as Error).message });
  }
  process.exit(1);
});
