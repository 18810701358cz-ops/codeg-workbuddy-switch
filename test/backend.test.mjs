// End-to-end backend test for WorkBuddy / CodeBuddy Switcher.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "backend", "server.mjs");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(base, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("backend did not become healthy");
}

function writeAuthFile(filePath, { email, access, refresh, domain }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        account: { uid: `uid_${email}`, nickname: email, email, lastLogin: true },
        auth: {
          accessToken: access,
          refreshToken: refresh,
          tokenType: "Bearer",
          domain: domain || "www.codebuddy.ai",
          expiresIn: 3600,
          expiresAt: Date.now() + 3600_000,
        },
      },
      null,
      2
    )
  );
}

test("workbuddy switcher: CLI auth import, switch, auto-rotation and json export/import", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbs-test-"));
  const dataDir = path.join(dir, "data");
  const authFile = path.join(dir, "auth", "Tencent-Cloud.coding-copilot.info");
  writeAuthFile(authFile, {
    email: "overseas-user1@example.com",
    access: "access-token-1",
    refresh: "refresh-token-1",
    domain: "www.codebuddy.ai",
  });

  const mockApi = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    res.writeHead(200, { "content-type": "application/json" });
    if (url.pathname === "/v2/plugin/auth/token/refresh") {
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            accessToken: "new-access-token",
            refreshToken: "new-refresh-token",
            expiresIn: 3600,
          },
        })
      );
      return;
    }
    res.end(JSON.stringify({ code: 0, data: {} }));
  });
  await new Promise((resolve) => mockApi.listen(0, "127.0.0.1", resolve));
  const mockPort = mockApi.address().port;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--no-warnings", serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      CODEG_PLUGIN_TOKEN: "test-token",
      CODEG_PLUGIN_DATA_DIR: dataDir,
      WBS_AUTH_PATH: authFile,
      WBS_ENDPOINT: `http://127.0.0.1:${mockPort}`,
      WBS_AUTO_ROTATE: "true",
      WBS_ROTATE_INTERVAL: "5",
      WBS_KILL_CLI: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c.toString()));

  try {
    await waitForHealth(base);
    const auth = { authorization: "Bearer test-token" };

    // 1. Get Accounts (auto-imports initial auth file)
    const listRes = await fetch(`${base}/api/accounts`, { headers: auth });
    assert.equal(listRes.status, 200);
    const data = await listRes.json();
    assert.ok(data.current);
    assert.equal(data.current.email, "overseas-user1@example.com");
    assert.equal(data.accounts.length, 1);
    assert.equal(data.accounts[0].region, "overseas");

    // 2. Import a second overseas account via token
    const importTokenRes = await fetch(`${base}/api/import-token`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        email: "overseas-user2@example.com",
        token: "refresh-token-2",
        domain: "www.codebuddy.ai",
      }),
    });
    assert.equal(importTokenRes.status, 200);

    const list2 = await (await fetch(`${base}/api/accounts`, { headers: auth })).json();
    assert.equal(list2.accounts.length, 2);
    const user2 = list2.accounts.find((a) => a.email === "overseas-user2@example.com");
    assert.ok(user2);

    // 3. Switch to user 2
    const switchRes = await fetch(`${base}/api/switch`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ id: user2.id }),
    });
    assert.equal(switchRes.status, 200);
    const sw = await switchRes.json();
    assert.equal(sw.pending, true);

    // Wait for switch
    for (let i = 0; i < 30; i += 1) {
      await sleep(100);
      const st = await (await fetch(`${base}/api/switch-status`, { headers: auth })).json();
      if (st.switch?.status === "success") break;
    }

    // Verify auth file was updated
    const updatedAuth = JSON.parse(fs.readFileSync(authFile, "utf8"));
    assert.equal(updatedAuth.account.email, "overseas-user2@example.com");

    // 4. Test auto-rotation trigger
    const rotateRes = await fetch(`${base}/api/rotate-now`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(rotateRes.status, 200);

    // 5. Test history
    const histRes = await fetch(`${base}/api/history`, { headers: auth });
    assert.equal(histRes.status, 200);
    const hist = await histRes.json();
    assert.ok(hist.entries.length >= 1);

    // 6. Test JSON Export
    const expRes = await fetch(`${base}/api/export`, { headers: auth });
    assert.equal(expRes.status, 200);
    const exp = await expRes.json();
    assert.ok(fs.existsSync(exp.path));

    // 7. Test Settings update
    const setRes = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ autoRotate: false }),
    });
    assert.equal(setRes.status, 200);
    const setJson = await setRes.json();
    assert.equal(setJson.config.autoRotate, false);
  } finally {
    child.kill();
    mockApi.close();
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(stderr.includes("Error:"), false, stderr);
  }
});
