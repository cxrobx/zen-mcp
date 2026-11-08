#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const port = 18767;
const ollamaPort = 18768;
let nextId = 1;

function child(name, command, args, options = {}) {
  const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], ...options });
  proc.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  return proc;
}

function waitForLine(proc, predicate, timeout = 7_000) {
  return new Promise((resolveP, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (predicate(parsed)) {
          clearTimeout(timer);
          proc.stdout.off("data", onData);
          resolveP(parsed);
          return;
        }
      }
    };
    proc.stdout.on("data", onData);
    const timer = setTimeout(() => {
      proc.stdout.off("data", onData);
      reject(new Error(`timeout waiting for JSON line; trailing=${buffer}`));
    }, timeout);
  });
}

async function startMcp(tokenPath) {
  const proc = child("mcp", "node", [resolve(root, "server/dist/index.js"), "--port", String(port), "--token-file", tokenPath]);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: nextId, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "nav-probe", version: "1" } } }) + "\n");
  await waitForLine(proc, (msg) => msg.id === nextId++);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return proc;
}

async function tool(proc, name, args = {}) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  const response = await waitForLine(proc, (msg) => msg.id === id, 10_000);
  if (!response.result) throw new Error(`${name} returned no result: ${JSON.stringify(response)}`);
  return response.result;
}

function text(result) {
  return result.content?.[0]?.text ?? "";
}

async function rawCall(token, method, params) {
  return new Promise((resolveP, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const id = `probe-${Date.now()}`;
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`raw ${method} timeout`)); }, 10_000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocolVersion: 1, role: "client", token })));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8"));
      if (msg.type === "welcome") ws.send(JSON.stringify({ type: "request", id, method, params }));
      if (msg.type === "response" && msg.id === id) {
        clearTimeout(timer);
        ws.close();
        if (msg.error) reject(new Error(msg.error.message));
        else resolveP(msg.result);
      }
    });
    ws.on("error", reject);
  });
}

async function pollPending(dir) {
  const pending = join(dir, "sessions", "pending");
  for (let i = 0; i < 40; i++) {
    const files = await readdir(pending);
    if (files.some((name) => name.endsWith(".json"))) return files.filter((name) => name.endsWith(".json"));
    await new Promise((resolveP) => setTimeout(resolveP, 100));
  }
  throw new Error("pending session log was not finalized");
}

function fakeOllama() {
  const vector = Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0);
  const server = createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.setHeader("content-type", "application/json");
      res.end('{"models":[]}');
      return;
    }
    if (req.url === "/api/embed") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const input = JSON.parse(body).input;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ embeddings: input.map(() => vector) }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolveP) => server.listen(ollamaPort, "127.0.0.1", () => resolveP(server)));
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), "zen-nav-probe-"));
  const tokenPath = join(scratch, "auth.token");
  const navDir = join(scratch, "nav-memory");
  const ollama = await fakeOllama();
  let daemon;
  let mcp;
  let mock;
  try {
    daemon = child("daemon", "node", [resolve(root, "daemon/dist/index.js"), "--port", String(port), "--token-file", tokenPath, "--nav-db", navDir, "--claude-bin", resolve(here, "fake-claude.mjs")], {
      env: { ...process.env, ZEN_MCP_NAV_ETL_PROBE: "1", ZEN_MCP_OLLAMA_URL: `http://127.0.0.1:${ollamaPort}` },
    });
    await new Promise((resolveP) => setTimeout(resolveP, 350));
    const token = (await readFile(tokenPath, "utf8")).trim();
    mcp = await startMcp(tokenPath);

    const seeded = text(await tool(mcp, "get_domain_playbook", { host: "console.cloud.google.com" }));
    if (!seeded.includes("[timing]") || !seeded.includes("Page indexes")) throw new Error("M0 seeds missing");
    const related = text(await tool(mcp, "get_domain_playbook", { host: "accounts.google.com" }));
    if (!related.includes("console.cloud.google.com")) throw new Error("M0 related-host fallback missing");
    const isolated = text(await tool(mcp, "get_domain_playbook", { host: "other.vercel.app" }));
    if (!isolated.includes("no nav notes")) throw new Error("M0 private suffix isolation failed");

    mock = child("mock", "node", [resolve(here, "mock-extension.mjs")], {
      env: { ...process.env, ZEN_MCP_URL: `ws://127.0.0.1:${port}`, ZEN_MCP_TOKEN_FILE: tokenPath },
    });
    await new Promise((resolveP) => setTimeout(resolveP, 250));
    const first = text(await tool(mcp, "navigate_page", { pageIdx: 0, url: "https://console.cloud.google.com/auth/clients/test" }));
    if (first.startsWith("[nav-memory]")) throw new Error("M1 unverified seed injected");
    const second = text(await tool(mcp, "navigate_page", { pageIdx: 0, url: "https://console.cloud.google.com/auth/clients/test" }));
    if (second.startsWith("[nav-memory]")) throw new Error("M1 duplicate injection");
    const containers = text(await tool(mcp, "list_containers"));
    if (containers.startsWith("[nav-memory]")) throw new Error("M1 injected into list tool");

    await tool(mcp, "navigate_page", { pageIdx: 0, url: "https://console.cloud.google.com/users/secret%40example.com/123456?token=bad" });
    await tool(mcp, "fill", { pageIdx: 0, selector: 'css:input[value="secret@example.com"][name="email"]', value: "secret@example.com" });
    await tool(mcp, "find_by_text", { pageIdx: 0, text: "user@host.com" });
    await new Promise((resolveP) => setTimeout(resolveP, 250));
    mcp.stdin.end();
    mcp = null;
    const files = await pollPending(navDir);
    const raw = (await Promise.all(files.map((name) => readFile(join(navDir, "sessions", "pending", name), "utf8")))).join("\n");
    for (const secret of ["secret@example.com", "secret%40example.com", "user@host.com", "token=bad"]) {
      if (raw.includes(secret)) throw new Error(`M2 leaked planted secret: ${secret}`);
    }

    let etl;
    do { etl = await rawCall(token, "navMemory.etlNow", {}); if (etl.status === "failed") throw new Error("M3 ETL failed"); } while (etl.status !== "empty");
    mcp = await startMcp(tokenPath);
    const learned = text(await tool(mcp, "get_domain_playbook", { host: "console.cloud.google.com" }));
    if (!learned.includes("fixture form")) throw new Error("M3 learned note missing");
    const afterFirst = JSON.parse(text(await tool(mcp, "nav_memory_stats")));
    if (afterFirst.notes < 7 || afterFirst.embeddings.present < 1) throw new Error("M4 stats missing notes/embeddings");
    if (afterFirst.etl.created < 1 || !afterFirst.etl.lastEtlAt) throw new Error("M4 ETL counters did not move");
    if (afterFirst.done < 1) throw new Error("M4 consumed work was not archived");

    // Second session on the same host: the distiller now sees the note it wrote
    // last time and reinforces it instead of inventing a fresh phrasing.
    await tool(mcp, "navigate_page", { pageIdx: 0, url: "https://console.cloud.google.com/users/secret%40example.com/123456?token=bad" });
    await tool(mcp, "fill", { pageIdx: 0, selector: 'css:input[name="email"]', value: "second@example.com" });
    await new Promise((resolveP) => setTimeout(resolveP, 250));
    mcp.stdin.end();
    mcp = null;
    await pollPending(navDir);
    const secondEtl = await rawCall(token, "navMemory.etlNow", {});
    if (secondEtl.status !== "processed") throw new Error(`M5 second ETL failed: ${JSON.stringify(secondEtl)}`);
    mcp = await startMcp(tokenPath);
    const reinforcedPlaybook = text(await tool(mcp, "get_domain_playbook", { host: "console.cloud.google.com" }));
    if (!/reinforced: 2/.test(reinforcedPlaybook)) throw new Error("M5 reinforcement did not increment the note");
    const stats = JSON.parse(text(await tool(mcp, "nav_memory_stats")));
    if (stats.notes !== afterFirst.notes) throw new Error(`M5 reinforcement created a duplicate note: ${afterFirst.notes} -> ${stats.notes}`);
    if (stats.etl.merged < 1) throw new Error("M5 merge counter did not move");
    if (stats.done < 2) throw new Error("M5 second work file was not archived");

    const learnedNote = JSON.parse(await readFile(join(navDir, "notes.json"), "utf8")).notes.find(note => note.summary.includes("fixture form"));
    const feedbackArgs = { tabId: 101, id: learnedNote.id, outcome: "confirmed", check: { selector: 'input[name="email"]', state: "value", value: "fixture" } };
    const rejected = await tool(mcp, "nav_memory_feedback", { ...feedbackArgs, check: { selector: "#retired", present: true } });
    if (!rejected.isError) throw new Error("M6 unverified assertion accepted");
    const obsoleteArgs = { ...feedbackArgs, outcome: "obsolete", check: { selector: "#retired", present: false } };
    const obsolete = text(await tool(mcp, "nav_memory_feedback", obsoleteArgs));
    if (!obsolete.includes("status: obsolete")) throw new Error("M6 obsolete feedback missing");
    const duplicate = text(await tool(mcp, "nav_memory_feedback", obsoleteArgs));
    if (!duplicate.includes("already recorded")) throw new Error("M6 repeated feedback counted twice");
    const afterObsolete = JSON.parse(text(await tool(mcp, "nav_memory_stats")));
    if (afterObsolete.feedback.obsoleteNotes !== 1 || afterObsolete.feedback.obsolete !== 1) throw new Error("M6 outcome counters wrong");
    const obsoletePlaybook = text(await tool(mcp, "get_domain_playbook", { host: "console.cloud.google.com" }));
    if (!obsoletePlaybook.includes("feedback: obsolete")) throw new Error("M6 obsolete note is not inspectable");
    const automatic = text(await tool(mcp, "navigate_page", { tabId: 101, url: "https://console.cloud.google.com/users/secret%40example.com/123456?token=bad" }));
    if (automatic.includes(learnedNote.id)) throw new Error("M6 obsolete note injected automatically");
    const recovered = text(await tool(mcp, "nav_memory_feedback", feedbackArgs));
    if (!recovered.includes("status: active") || !recovered.includes("obsolete: 0")) throw new Error("M6 corrected session verdict failed");

    const independent = await startMcp(tokenPath);
    try {
      const another = text(await tool(independent, "nav_memory_feedback", feedbackArgs));
      if (!another.includes("confirmed: 2")) throw new Error("M6 independent session did not count");
      await tool(independent, "navigate_page", { tabId: 102, url: "https://console.cloud.google.com/users/secret%40example.com/123456?token=bad" });
      const wrongHost = await tool(independent, "nav_memory_feedback", { ...feedbackArgs, tabId: 102 });
      // Both fixture tabs are on the same console initially; move the second
      // tab to an unrelated host and prove it cannot vote for this note.
      if (wrongHost.isError) throw new Error("M6 same-host verification failed");
      await tool(independent, "navigate_page", { tabId: 102, url: "https://example.com/" });
      const mismatch = await tool(independent, "nav_memory_feedback", { ...feedbackArgs, tabId: 102 });
      if (!mismatch.isError) throw new Error("M6 cross-host feedback accepted");
    } finally {
      independent.stdin.end();
    }
    const forgotten = text(await tool(mcp, "nav_memory_forget", { host: "console.cloud.google.com" }));
    if (!forgotten.includes("notes=7")) throw new Error(`M4 forget failed: ${forgotten}`);
    const empty = text(await tool(mcp, "get_domain_playbook", { host: "console.cloud.google.com" }));
    if (!empty.includes("no nav notes")) throw new Error("M4 forgotten notes still queryable");

    console.error("[probe-navmem] PASS");
  } finally {
    if (mcp) mcp.kill("SIGTERM");
    if (mock) mock.kill("SIGTERM");
    if (daemon) daemon.kill("SIGTERM");
    await new Promise((resolveP) => ollama.close(resolveP));
    await new Promise((resolveP) => setTimeout(resolveP, 150));
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[probe-navmem] FAIL:", err.stack ?? err.message);
  process.exitCode = 1;
});
