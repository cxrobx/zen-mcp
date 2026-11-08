#!/usr/bin/env node
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const url = process.env.ZEN_MCP_URL ?? "ws://127.0.0.1:8766";
const tokenPath =
  process.env.ZEN_MCP_TOKEN_FILE ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "zen-mcp", "auth.token");
const token = readFileSync(tokenPath, "utf8").trim();

const FIXTURE_CONTAINERS = [
  { cookieStoreId: "firefox-container-1", name: "Personal", color: "blue", icon: "fingerprint" },
  { cookieStoreId: "firefox-container-2", name: "Work", color: "orange", icon: "briefcase" },
  { cookieStoreId: "firefox-container-3", name: "Geek", color: "yellow", icon: "circle" },
  { cookieStoreId: "firefox-container-4", name: "Buildersbuddy", color: "green", icon: "tree" },
  { cookieStoreId: "firefox-container-5", name: "Artist Advisory", color: "pink", icon: "vacation" },
  { cookieStoreId: "firefox-container-6", name: "CXVentures", color: "purple", icon: "briefcase" },
];

const FIXTURE_PAGES = [
  {
    tabId: 101,
    windowId: 1,
    index: 0,
    url: "https://example.com/",
    title: "Example",
    active: true,
    cookieStoreId: "firefox-container-1",
    containerName: "Personal",
  },
  {
    tabId: 102,
    windowId: 1,
    index: 1,
    url: "https://console.cloud.google.com/auth/clients/example",
    title: "Cloud Console",
    active: false,
    cookieStoreId: "firefox-container-2",
    containerName: "Work",
  },
];

const ws = new WebSocket(url);

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      role: "extension",
      token,
    }),
  );
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString("utf8"));
  if (msg.type === "welcome") {
    console.error("[mock-extension] welcome", msg.serverId);
    return;
  }
  if (msg.type === "unauthorized") {
    console.error("[mock-extension] unauthorized:", msg.reason);
    process.exit(1);
  }
  if (msg.type === "ping") {
    ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
    return;
  }
  if (msg.type === "request") {
    if (msg.method === "containers.list") {
      ws.send(
        JSON.stringify({
          type: "response",
          id: msg.id,
          result: { containers: FIXTURE_CONTAINERS },
        }),
      );
      return;
    }
    if (msg.method === "pages.list") {
      ws.send(JSON.stringify({ type: "response", id: msg.id, result: { pages: FIXTURE_PAGES } }));
      return;
    }
    if (msg.method === "pages.navigate") {
      const page = FIXTURE_PAGES.find((item) => item.tabId === msg.params?.tabId);
      if (page && typeof msg.params?.url === "string") page.url = msg.params.url;
      ws.send(JSON.stringify({ type: "response", id: msg.id, result: { tabId: msg.params?.tabId } }));
      return;
    }
    if (msg.method === "dom.fillByLocator") {
      const page = FIXTURE_PAGES.find((item) => item.tabId === msg.params?.tabId) ?? FIXTURE_PAGES[0];
      ws.send(JSON.stringify({
        type: "response",
        id: msg.id,
        result: {
          tabId: msg.params?.tabId,
          matchedTag: "INPUT",
          feedback: { url: page?.url ?? "https://example.com/", title: "Fixture", navigated: false },
        },
      }));
      return;
    }
    if (msg.method === "dom.clickByLocator") {
      const page = FIXTURE_PAGES.find((item) => item.tabId === msg.params?.tabId) ?? FIXTURE_PAGES[0];
      if (page) page.url = "https://accounts.google.com/signin";
      ws.send(JSON.stringify({
        type: "response",
        id: msg.id,
        result: {
          tabId: msg.params?.tabId,
          matchedTag: "A",
          feedback: { url: page?.url ?? "https://accounts.google.com/signin", title: "Accounts", navigated: true },
        },
      }));
      return;
    }
    if (msg.method === "dom.takeSnapshot") {
      ws.send(JSON.stringify({
        type: "response",
        id: msg.id,
        result: {
          tabId: msg.params?.tabId,
          snapshotId: 1,
          tree: {
            uid: "root",
            tag: "body",
            children: [{ uid: "email", tag: "span", role: "status", text: "user@host.com", children: [] }],
          },
          uidMap: [{ uid: "email", css: "span.status" }],
          truncated: false,
        },
      }));
      return;
    }
    if (msg.method === "dom.evaluate") {
      const page = FIXTURE_PAGES.find(item => item.tabId === msg.params?.tabId);
      try {
        const result = runInNewContext(`(function(){${msg.params.code}})()`, {
          location: { href: page?.url },
          document: { readyState: "complete", querySelector(selector) { return selector === 'input[name="email"]' ? { disabled: false, value: 'fixture' } : null; } },
        });
        ws.send(JSON.stringify({ type: "response", id: msg.id, result: { result } }));
      } catch {
        ws.send(JSON.stringify({ type: "response", id: msg.id, error: { code: -32602, message: "fixture assertion failed" } }));
      }
      return;
    }
    ws.send(
      JSON.stringify({
        type: "response",
        id: msg.id,
        error: { code: -32601, message: `mock has no handler for ${msg.method}` },
      }),
    );
  }
});

ws.on("close", () => {
  console.error("[mock-extension] closed");
  process.exit(0);
});

ws.on("error", (err) => {
  console.error("[mock-extension] error", err.message);
  process.exit(1);
});

process.on("SIGTERM", () => ws.close());
process.on("SIGINT", () => ws.close());
