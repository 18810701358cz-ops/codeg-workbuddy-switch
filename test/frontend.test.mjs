// Frontend smoke test for WorkBuddy / CodeBuddy Switcher.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeNode(tag = "div") {
  const node = {
    tagName: tag.toUpperCase(),
    className: "",
    textContent: "",
    title: "",
    disabled: false,
    style: {},
    children: [],
    classList: { add: (name) => (node.className += ` ${name}`) },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    append(...children) {
      node.children.push(...children);
    },
    remove() {},
    addEventListener() {},
  };
  return node;
}

function textOf(node) {
  return (
    (node.textContent || "") +
    (node.children || []).map((child) => textOf(child)).join(" ")
  );
}

const documentStub = {
  body: makeNode("body"),
  createElement: (tag) => makeNode(tag),
  addEventListener() {},
  removeEventListener() {},
};

globalThis.window = {
  location: { pathname: "/workspace", search: "?conversationId=1" },
  confirm: () => true,
};
globalThis.document = documentStub;

const accountsPayload = {
  current: { email: "overseas-active@example.com", nickname: "Overseas Active" },
  accounts: [
    {
      id: "cb_1",
      email: "overseas-active@example.com",
      nickname: "Overseas Active",
      region: "overseas",
      domain: "www.codebuddy.ai",
      isCliActive: true,
      pointsBalance: 520,
      pointsExpiresAt: Date.now() + 86400_000 * 3,
      hasRefreshToken: true,
    },
    {
      id: "cb_2",
      email: "backup-user@example.com",
      nickname: "Backup User",
      region: "overseas",
      domain: "www.codebuddy.ai",
      isCliActive: false,
      pointsBalance: 200,
      pointsExpiresAt: Date.now() + 86400_000 * 10,
      hasRefreshToken: true,
    },
  ],
  config: {
    autoRotate: true,
    rotateIntervalMinutes: 5,
  },
  authPath: "C:/auth/Tencent-Cloud.coding-copilot.info",
};

const historyPayload = {
  entries: [
    {
      id: 1,
      email: "overseas-active@example.com",
      reason: "auto_rotation_urgency",
      at: Date.now(),
      result: "success",
    },
  ],
};

test("workbuddy-switch: activate registers slots and renders panel & status bar", async () => {
  const module = await import(
    pathToFileURL(path.join(here, "..", "main.js")).href + "?test=" + Date.now()
  );

  const slots = new Map();
  const ctx = {
    id: "workbuddy-switch",
    version: "1.0.0",
    injectCSS() {},
    registerSlot(name, item) {
      slots.set(name, item);
    },
    notify() {},
    logger: { info() {}, error() {} },
    backend: {
      fetch: async (url) => {
        let body = {};
        if (url.startsWith("/api/accounts")) body = accountsPayload;
        else if (url.startsWith("/api/history")) body = historyPayload;
        return { status: 200, body: JSON.stringify(body) };
      },
    },
  };

  await module.activate(ctx);
  await new Promise((r) => setTimeout(r, 150));

  assert.ok(slots.has("statusbar.right"));
  assert.ok(slots.has("settings.plugin-detail"));

  // Mount settings panel
  const host = makeNode();
  const cleanup = slots.get("settings.plugin-detail").mount(host);
  await new Promise((r) => setTimeout(r, 50));
  const text = textOf(host);

  assert.match(text, /CodeBuddy 自动换号器/);
  assert.match(text, /overseas-active@example\.com/);
  assert.match(text, /海外版/);
  assert.match(text, /自动轮换开启/);
  assert.match(text, /积分: 520/);
  assert.match(text, /添加账号/);
  assert.match(text, /导入 JSON/);
  assert.match(text, /导出 JSON/);

  // Mount status bar
  const statusHost = makeNode();
  const cleanupStatus = slots.get("statusbar.right").mount(statusHost);
  const statusText = textOf(statusHost);
  assert.match(statusText, /CB overseas-active/);

  cleanupStatus();
  cleanup();
  module.deactivate();
});
