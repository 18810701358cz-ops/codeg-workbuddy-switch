// WorkBuddy / CodeBuddy Switcher — plugin backend.
//
// Native multi-account management & auto-rotator for CodeBuddy CLI & IDE.
// Supports Overseas (codebuddy.ai / Google / GitHub) and Domestic endpoints.
// Urgency-based auto-rotation rotates CLI accounts before points expire.
//
// Requires Node 22.5+ for native `node:sqlite`. No third-party dependencies.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { exec, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const VERSION = "1.0.0";
const PORT = Number(process.env.PORT || 0);
const TOKEN = process.env.CODEG_PLUGIN_TOKEN || "";
const DATA_DIR =
  process.env.CODEG_PLUGIN_DATA_DIR ||
  path.join(os.tmpdir(), "codeg-workbuddy-switch");

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const LOCALAPPDATA =
  process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");

function defaultCodeBuddyAuthPath() {
  if (process.platform === "win32") {
    return path.join(
      LOCALAPPDATA,
      "CodeBuddyExtension",
      "Data",
      "Public",
      "auth",
      "Tencent-Cloud.coding-copilot.info"
    );
  }
  if (process.platform === "darwin") {
    return path.join(
      HOME,
      "Library",
      "Application Support",
      "CodeBuddyExtension",
      "Data",
      "Public",
      "auth",
      "Tencent-Cloud.coding-copilot.info"
    );
  }
  return path.join(
    HOME,
    ".local",
    "share",
    "CodeBuddyExtension",
    "Data",
    "Public",
    "auth",
    "Tencent-Cloud.coding-copilot.info"
  );
}

const DEFAULT_CODEG_DB = path.join(APPDATA, "app.codeg", "codeg.db");
const CODEG_DB =
  (process.env.WBS_CODEG_DB_PATH || "").trim() || DEFAULT_CODEG_DB;
const AUTH_PATH =
  (process.env.WBS_AUTH_PATH || "").trim() || defaultCodeBuddyAuthPath();
const ENDPOINT =
  ((process.env.WBS_ENDPOINT || "").trim() ||
    "https://www.codebuddy.ai").replace(/\/+$/, "");
const DB_PATH = path.join(DATA_DIR, "workbuddy-switch.db");
const EXPORT_DIR = path.join(HOME, "Downloads", "Codeg Accounts");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const MAX_BACKUPS = 10;

let configState = {
  endpoint: ENDPOINT,
  autoRotate: process.env.WBS_AUTO_ROTATE !== "false",
  rotateIntervalMinutes: Number(process.env.WBS_ROTATE_INTERVAL) || 5,
  killCliOnSwitch: process.env.WBS_KILL_CLI !== "false",
  lastSwitch: null,
  lastError: null,
};

let activeSwitch = null;
let activeLogin = null;
let rotationTimer = null;

function nowIso() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(`[workbuddy-switch]`, ...args);
}

function safeJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value, mode = 0o600) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`
  );
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  try {
    if (fs.existsSync(file)) fs.rmSync(file);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function backupStamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
}

function backupFile(target) {
  if (!fs.existsSync(target)) return null;
  const dir = path.dirname(target);
  const base = path.basename(target);
  const stamp = backupStamp();
  const backup = path.join(dir, `${base}.bak-${stamp}`);
  try {
    fs.copyFileSync(target, backup);
    pruneBackups(target);
    return backup;
  } catch (err) {
    log("backup failed:", err.message);
    return null;
  }
}

function listBackups(target) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.bak-`))
      .map((name) => {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        return { name, path: full, mtime: stat.mtime.toISOString(), size: stat.size };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  } catch {
    return [];
  }
}

function pruneBackups(target) {
  const entries = listBackups(target);
  for (const item of entries.slice(MAX_BACKUPS)) {
    try {
      fs.unlinkSync(item.path);
    } catch {}
  }
}

function loadState() {
  const saved = readJson(STATE_FILE);
  if (saved && typeof saved === "object") {
    configState = { ...configState, ...saved };
  }
}

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(configState, null, 2) + "\n",
      { mode: 0o600 }
    );
  } catch (err) {
    log("state save failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function openStore() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      uid TEXT,
      email TEXT NOT NULL,
      nickname TEXT,
      avatar_url TEXT,
      enterprise_id TEXT,
      enterprise_name TEXT,
      plan_type TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      token_type TEXT,
      expires_at INTEGER,
      refresh_expires_at INTEGER,
      domain TEXT,
      region TEXT,
      status TEXT,
      points_balance INTEGER,
      points_expires_at INTEGER,
      quota_used INTEGER,
      quota_total INTEGER,
      is_cli_active INTEGER DEFAULT 0,
      source TEXT,
      last_used INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_acc_email ON accounts(email);
    CREATE INDEX IF NOT EXISTS idx_acc_uid ON accounts(uid);
    CREATE TABLE IF NOT EXISTS switch_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT,
      email TEXT NOT NULL,
      from_account_id TEXT,
      from_email TEXT,
      reason TEXT,
      switched_at INTEGER NOT NULL,
      result TEXT NOT NULL,
      message TEXT,
      backup_path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_history_time ON switch_history(switched_at DESC);
  `);
  return db;
}

function withStore(fn) {
  const db = openStore();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function recordHistory({
  accountId,
  email,
  fromAccountId,
  fromEmail,
  reason = "manual",
  at,
  result,
  message,
  backupPath,
}) {
  try {
    withStore((db) => {
      db.prepare(`
        INSERT INTO switch_history (
          account_id, email, from_account_id, from_email, reason,
          switched_at, result, message, backup_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        accountId || null,
        email,
        fromAccountId || null,
        fromEmail || null,
        reason,
        at || Date.now(),
        result,
        message || null,
        backupPath || null
      );
    });
  } catch (err) {
    log("recordHistory failed:", err.message);
  }
}

function listHistory(limit = 20) {
  try {
    return withStore((db) =>
      db
        .prepare(`
          SELECT id, account_id, email, from_account_id, from_email, reason,
                 switched_at, result, message, backup_path
            FROM switch_history
           ORDER BY switched_at DESC
           LIMIT ?
        `)
        .all(limit)
        .map((row) => ({
          id: row.id,
          accountId: row.account_id,
          email: row.email,
          fromAccountId: row.from_account_id,
          fromEmail: row.from_email,
          reason: row.reason || "manual",
          at: row.switched_at,
          result: row.result,
          message: row.message,
          backupPath: row.backup_path,
        }))
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Network / Proxy Tunnel
// ---------------------------------------------------------------------------

function proxyUrl() {
  const str =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    "";
  if (!str.trim()) return null;
  try {
    return new URL(str);
  } catch {
    return null;
  }
}

function bypassProxy(hostname) {
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const target = (hostname || "").toLowerCase();
  for (const entry of noProxy) {
    if (entry === "*") return true;
    if (entry.startsWith(".")) {
      if (target.endsWith(entry) || target === entry.slice(1)) return true;
    } else if (target === entry || target.endsWith(`.${entry}`)) {
      return true;
    }
  }
  return false;
}

function proxyFor(target) {
  const proxy = proxyUrl();
  if (!proxy || bypassProxy(target.hostname)) return null;
  return proxy;
}

function connectProxyTunnel(proxy, targetHost, targetPort, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
    });
    socket.setTimeout(timeoutMs);

    let head = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
    if (proxy.username) {
      const auth = Buffer.from(
        `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || "")}`
      ).toString("base64");
      head += `Proxy-Authorization: Basic ${auth}\r\n`;
    }
    head += "Proxy-Connection: Keep-Alive\r\n\r\n";

    socket.on("connect", () => socket.write(head));
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("代理 CONNECT 超时"));
    });
    socket.on("error", reject);

    let buffer = "";
    function onData(chunk) {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.removeListener("data", onData);
      const [statusLine] = buffer.slice(0, end).split("\r\n");
      const match = /^HTTP\/\d\.\d\s+(\d+)/.exec(statusLine);
      const code = match ? Number(match[1]) : 0;
      if (code < 200 || code >= 300) {
        socket.destroy();
        return reject(new Error(`代理连接失败：${statusLine}`));
      }
      resolve(socket);
    }
    socket.on("data", onData);
  });
}

async function requestApi(pathname, options = {}) {
  const base = (options.endpoint || configState.endpoint || ENDPOINT).replace(/\/+$/, "");
  const targetUrl = new URL(pathname, base);
  const timeoutMs = options.timeoutMs || 25000;
  const isHttps = targetUrl.protocol === "https:";
  const proxy = proxyFor(targetUrl);

  const perform = (agent) =>
    new Promise((resolve, reject) => {
      const transport = isHttps ? https : http;
      const headers = {
        "content-type": "application/json",
        accept: "application/json",
        ...(options.headers || {}),
      };
      const req = transport.request(
        targetUrl,
        {
          method: options.method || "GET",
          headers,
          agent,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let json = null;
            try {
              json = JSON.parse(raw);
            } catch {}
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const msg = json?.message || json?.error || `HTTP ${res.statusCode}`;
              return reject(new Error(`API 失败 (${msg})`));
            }
            if (json && json.code !== 0 && json.code !== 200 && json.code != null) {
              return reject(new Error(json.message || `业务错误码 ${json.code}`));
            }
            resolve(json?.data !== undefined ? json.data : json);
          });
        }
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error("API 请求超时"));
      });
      req.on("error", reject);
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });

  if (!proxy) return perform(null);

  if (!isHttps) {
    const agent = new http.Agent({
      proxy: {
        host: proxy.hostname,
        port: Number(proxy.port || 80),
      },
    });
    return perform(agent);
  }

  const tunnel = await connectProxyTunnel(
    proxy,
    targetUrl.hostname,
    Number(targetUrl.port || 443),
    timeoutMs
  );
  const tlsSocket = tls.connect({
    socket: tunnel,
    servername: targetUrl.hostname,
    rejectUnauthorized: true,
  });
  await new Promise((resolve, reject) => {
    tlsSocket.once("secureConnect", resolve);
    tlsSocket.once("error", reject);
  });
  const agent = new https.Agent();
  agent.createConnection = () => tlsSocket;
  return perform(agent);
}

// ---------------------------------------------------------------------------
// Account / Token Helpers
// ---------------------------------------------------------------------------

function accountIdFrom(uid, email) {
  const seed = String(uid || email || "workbuddy").toLowerCase();
  return `cb_${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function sanitizeAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    uid: row.uid || null,
    email: row.email,
    nickname: row.nickname || row.email,
    avatarUrl: row.avatar_url || null,
    enterpriseId: row.enterprise_id || null,
    enterpriseName: row.enterprise_name || null,
    planType: row.plan_type || "Free",
    hasRefreshToken: Boolean(row.refresh_token),
    tokenExpiry: row.expires_at || null,
    refreshTokenExpiry: row.refresh_expires_at || null,
    domain: row.domain || "www.codebuddy.ai",
    region: row.region || (row.domain?.includes("codebuddy.ai") ? "overseas" : "domestic"),
    status: row.status || "active",
    pointsBalance: row.points_balance != null ? row.points_balance : null,
    pointsExpiresAt: row.points_expires_at || null,
    quotaUsed: row.quota_used || 0,
    quotaTotal: row.quota_total || 0,
    isCliActive: Boolean(row.is_cli_active),
    lastUsed: row.last_used || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listAccounts() {
  return withStore((db) =>
    db
      .prepare(`SELECT * FROM accounts ORDER BY is_cli_active DESC, updated_at DESC`)
      .all()
      .map(sanitizeAccount)
  );
}

function currentCliAccount() {
  const file = readJson(AUTH_PATH);
  if (!file) return null;
  const email = file?.account?.email || file?.account?.nickname;
  const uid = file?.account?.uid;
  if (!email && !uid) return null;
  return {
    uid: uid || null,
    email: email || "unknown",
    nickname: file?.account?.nickname || email,
    uin: file?.account?.uin || null,
    authFile: AUTH_PATH,
  };
}

function upsertAccount(payload, options = {}) {
  const rawEmail = payload.email || payload.nickname || "";
  const email = String(rawEmail).replace(/[`'"]/g, "").trim();
  const nickname = String(payload.nickname || email).replace(/[`'"]/g, "").trim();
  const uid = payload.uid || null;
  if (!email && !uid) throw new Error("缺少账号信息 (email 或 uid)");
  const id = payload.id || accountIdFrom(uid, email);
  const now = Date.now();
  const domain = payload.domain || "www.codebuddy.ai";
  const region = payload.region || (domain.includes("codebuddy.ai") ? "overseas" : "domestic");

  return withStore((db) => {
    const existing = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id);
    if (existing) {
      db.prepare(`
        UPDATE accounts
           SET uid = coalesce(?, uid),
               email = coalesce(?, email),
               nickname = coalesce(?, nickname),
               avatar_url = coalesce(?, avatar_url),
               plan_type = coalesce(?, plan_type),
               access_token = coalesce(?, access_token),
               refresh_token = coalesce(?, refresh_token),
               token_type = coalesce(?, token_type),
               expires_at = coalesce(?, expires_at),
               refresh_expires_at = coalesce(?, refresh_expires_at),
               domain = coalesce(?, domain),
               region = coalesce(?, region),
               points_balance = coalesce(?, points_balance),
               points_expires_at = coalesce(?, points_expires_at),
               status = coalesce(?, status),
               updated_at = ?
         WHERE id = ?
      `).run(
        uid,
        email,
        payload.nickname || null,
        payload.avatarUrl || null,
        payload.planType || null,
        payload.accessToken || null,
        payload.refreshToken || null,
        payload.tokenType || "Bearer",
        payload.expiresAt || null,
        payload.refreshExpiresAt || null,
        domain,
        region,
        payload.pointsBalance != null ? payload.pointsBalance : null,
        payload.pointsExpiresAt || null,
        payload.status || "active",
        now,
        id
      );
    } else {
      db.prepare(`
        INSERT INTO accounts (
          id, uid, email, nickname, avatar_url, enterprise_id, enterprise_name,
          plan_type, access_token, refresh_token, token_type, expires_at,
          refresh_expires_at, domain, region, status, points_balance,
          points_expires_at, quota_used, quota_total, is_cli_active, source,
          last_used, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, 0, 0, 0, ?,
          ?, ?, ?
        )
      `).run(
        id,
        uid,
        email,
        payload.nickname || email,
        payload.avatarUrl || null,
        payload.enterpriseId || null,
        payload.enterpriseName || null,
        payload.planType || "Free",
        payload.accessToken || "",
        payload.refreshToken || null,
        payload.tokenType || "Bearer",
        payload.expiresAt || null,
        payload.refreshExpiresAt || null,
        domain,
        region,
        payload.status || "active",
        payload.pointsBalance != null ? payload.pointsBalance : null,
        payload.pointsExpiresAt || null,
        options.source || "manual",
        options.lastUsed || null,
        now,
        now
      );
    }
    return db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id);
  });
}

async function refreshAccountTokens(account) {
  if (!account.refresh_token) throw new Error("该账号没有 refresh_token");
  let endpoint = configState.endpoint;
  if (!endpoint || endpoint.includes("codebuddy.ai")) {
    endpoint = account.domain ? `https://${account.domain}` : "https://www.codebuddy.ai";
  }
  const res = await requestApi("/v2/plugin/auth/token/refresh", {
    method: "POST",
    endpoint,
    headers: {
      "x-refresh-token": account.refresh_token,
    },
  });
  const now = Date.now();
  const accessToken = res.accessToken || res.access_token;
  const refreshToken = res.refreshToken || res.refresh_token || account.refresh_token;
  const expiresIn = Number(res.expiresIn || res.expires_in || 3600);
  const expiresAt = now + expiresIn * 1000;
  const refreshExpiresAt = res.refreshExpiresIn
    ? now + Number(res.refreshExpiresIn) * 1000
    : account.refresh_expires_at;

  withStore((db) => {
    db.prepare(`
      UPDATE accounts
         SET access_token = ?,
             refresh_token = ?,
             expires_at = ?,
             refresh_expires_at = ?,
             updated_at = ?
       WHERE id = ?
    `).run(accessToken, refreshToken, expiresAt, refreshExpiresAt, now, account.id);
  });

  return { accessToken, refreshToken, expiresAt, refreshExpiresAt };
}

function killCliProcesses() {
  if (!configState.killCliOnSwitch) return;
  if (process.platform === "win32") {
    exec("taskkill /F /IM codebuddy.exe /IM cb.exe /T", () => {});
  } else {
    exec("pkill -f codebuddy || pkill -f cb", () => {});
  }
}

function writeCliAuthFile(account, tokens) {
  const backup = backupFile(AUTH_PATH);
  const payload = {
    account: {
      uid: account.uid || undefined,
      nickname: account.nickname || account.email,
      email: account.email,
      lastLogin: true,
      type: "personal",
    },
    auth: {
      accessToken: tokens.accessToken || account.access_token,
      refreshToken: tokens.refreshToken || account.refresh_token,
      tokenType: account.token_type || "Bearer",
      expiresIn: Math.max(0, Math.floor(((tokens.expiresAt || account.expires_at || 0) - Date.now()) / 1000)),
      expiresAt: tokens.expiresAt || account.expires_at,
      refreshExpiresAt: tokens.refreshExpiresAt || account.refresh_expires_at,
      domain: account.domain || "www.codebuddy.ai",
      scope: "openid profile offline_access email",
    },
    accounts: [
      {
        uid: account.uid || undefined,
        nickname: account.nickname || account.email,
        email: account.email,
        lastLogin: true,
        type: "personal",
      },
    ],
  };

  writeJsonAtomic(AUTH_PATH, payload, 0o600);

  // Sync to ~/.codebuddy/settings.json if present
  try {
    const cbSettings = path.join(HOME, ".codebuddy", "settings.json");
    if (fs.existsSync(cbSettings)) {
      const cfg = readJson(cbSettings) || {};
      cfg.currentAccount = account.email;
      cfg.endpoint = account.domain ? `https://${account.domain}` : configState.endpoint;
      writeJsonAtomic(cbSettings, cfg);
    }
  } catch {}

  killCliProcesses();
  return backup;
}

// ---------------------------------------------------------------------------
// Switcher & Auto-Rotator
// ---------------------------------------------------------------------------

async function performSwitch(accountId, reason = "manual") {
  const row = withStore((db) => db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId));
  if (!row) throw new Error("找不到该账号");

  const from = currentCliAccount();
  let tokens = { accessToken: row.access_token, refreshToken: row.refresh_token };

  // Instant offline switch: Write tokens directly without blocking network calls
  const backupPath = writeCliAuthFile(row, tokens);
  const now = Date.now();

  withStore((db) => {
    db.prepare(`UPDATE accounts SET is_cli_active = 0`).run();
    db.prepare(`UPDATE accounts SET is_cli_active = 1, last_used = ?, updated_at = ? WHERE id = ?`).run(
      now,
      now,
      row.id
    );
  });

  recordHistory({
    accountId: row.id,
    email: row.email,
    fromAccountId: from?.email ? accountIdFrom(from.uid, from.email) : null,
    fromEmail: from?.email || null,
    reason,
    at: now,
    result: "success",
    backupPath,
  });

  configState.lastSwitch = { id: row.id, email: row.email, at: nowIso(), reason };
  saveState();
  log(`switched CLI to ${row.email} (${reason})`);

  return {
    ok: true,
    email: row.email,
    id: row.id,
    reason,
    backupPath,
  };
}

function startAsyncSwitch(accountId, reason = "manual") {
  const switchId = `sw_${Date.now()}`;
  activeSwitch = {
    id: switchId,
    accountId,
    status: "running",
    startedAt: nowIso(),
    error: null,
    result: null,
  };
  (async () => {
    try {
      const result = await performSwitch(accountId, reason);
      activeSwitch.status = "success";
      activeSwitch.result = result;
    } catch (err) {
      activeSwitch.status = "error";
      activeSwitch.error = err.message;
      recordHistory({
        accountId,
        email: accountId,
        reason,
        at: Date.now(),
        result: "error",
        message: err.message,
      });
    }
  })();
  return { pending: true, switchId };
}

// Urgency-based rotation strategy:
// Sorts accounts with valid tokens by points_expires_at ASC (closest expiration first),
// then by remaining points. Rotates if current account is expired or near expiry.
async function checkAndAutoRotate() {
  if (!configState.autoRotate) return;
  try {
    const accounts = withStore((db) =>
      db
        .prepare(`SELECT * FROM accounts WHERE status = 'active' AND refresh_token IS NOT NULL`)
        .all()
    );
    if (accounts.length < 2) return;

    const now = Date.now();
    // Sort by urgency:
    // Accounts with valid points that expire earliest come first.
    accounts.sort((a, b) => {
      const expA = a.points_expires_at || a.expires_at || Number.MAX_SAFE_INTEGER;
      const expB = b.points_expires_at || b.expires_at || Number.MAX_SAFE_INTEGER;
      return expA - expB;
    });

    const activeAcc = accounts.find((a) => a.is_cli_active === 1);
    const bestAcc = accounts[0];

    // If active account has expired or if best candidate has urgent expiration coming up (< 3 days)
    if (!activeAcc || activeAcc.id !== bestAcc.id) {
      log(`Auto-rotation triggered: switching from ${activeAcc?.email || "none"} to urgent candidate ${bestAcc.email}`);
      await performSwitch(bestAcc.id, "auto_rotation_urgency");
    }
  } catch (err) {
    log("auto-rotation check failed:", err.message);
  }
}

function setupRotationTimer() {
  if (rotationTimer) clearInterval(rotationTimer);
  const ms = Math.max(1, configState.rotateIntervalMinutes) * 60 * 1000;
  rotationTimer = setInterval(checkAndAutoRotate, ms);
}

// ---------------------------------------------------------------------------
// OAuth / Login flow (Supports Overseas & Domestic)
// ---------------------------------------------------------------------------

async function startOAuthLogin(domain = "www.codebuddy.ai") {
  const id = `login_${Date.now()}`;
  activeLogin = {
    id,
    status: "starting",
    domain,
    authUrl: null,
    account: null,
    error: null,
    startedAt: nowIso(),
  };

  (async () => {
    try {
      const endpoint = `https://${domain}`;
      const stateData = await requestApi("/v2/plugin/auth/state?platform=ide", { endpoint });
      if (activeLogin?.id !== id) return;
      const state = stateData?.state;
      const authUrl = stateData?.authUrl;
      if (!state || !authUrl) throw new Error("服务端未返回授权地址");

      activeLogin.state = state;
      activeLogin.authUrl = authUrl;
      activeLogin.status = "pending";

      // Poll for completion
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        if (activeLogin?.id !== id || activeLogin.status !== "pending") return;

        let tokenData;
        try {
          tokenData = await requestApi(`/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, { endpoint });
        } catch {
          continue;
        }

        if (tokenData && (tokenData.accessToken || tokenData.access_token)) {
          const acc = upsertAccount({
            uid: tokenData.uid,
            email: tokenData.email || tokenData.nickname,
            nickname: tokenData.nickname,
            accessToken: tokenData.accessToken || tokenData.access_token,
            refreshToken: tokenData.refreshToken || tokenData.refresh_token,
            domain,
            region: domain.includes("codebuddy.ai") ? "overseas" : "domestic",
            expiresAt: Date.now() + Number(tokenData.expiresIn || 3600) * 1000,
          }, { source: "oauth" });

          activeLogin.status = "success";
          activeLogin.account = sanitizeAccount(acc);
          log("OAuth login succeeded for", acc.email);
          return;
        }
      }
      if (activeLogin?.id === id && activeLogin.status === "pending") {
        activeLogin.status = "error";
        activeLogin.error = "登录超时，请重试";
      }
    } catch (err) {
      if (activeLogin?.id === id) {
        activeLogin.status = "error";
        activeLogin.error = err.message;
      }
    }
  })();

  return { id };
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function authorized(req) {
  if (!TOKEN) return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function writeExportFile(payload) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const filename = `codebuddy-accounts-${backupStamp()}.json`;
  const file = path.join(EXPORT_DIR, filename);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  return { path: file, filename, size: fs.statSync(file).size };
}

function openPath(target) {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) throw new Error("文件或目录不存在");
  let command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  let args = process.platform === "win32" ? [`/select,${resolved}`] : [resolved];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}


function scanAndImportLocalAccounts() {
  const authDir = path.dirname(AUTH_PATH);
  if (!fs.existsSync(authDir)) return 0;
  let count = 0;
  try {
    const files = fs.readdirSync(authDir);
    for (const file of files) {
      if (file.endsWith(".logged-out")) continue;
      if (!file.includes("coding-copilot") && !file.includes("workbuddy")) continue;
      try {
        const fullPath = path.join(authDir, file);
        const data = readJson(fullPath);
        if (!data) continue;
        const acc = data.account || (Array.isArray(data.accounts) && data.accounts[0]);
        const auth = data.auth;
        const rawEmail = acc?.email || acc?.nickname;
        const uid = acc?.uid;
        const token = typeof auth?.accessToken === "string" ? auth.accessToken : null;
        const refreshToken = typeof auth?.refreshToken === "string" ? auth.refreshToken : null;
        if (!token && !refreshToken) continue;
        if (!rawEmail && !uid) continue;

        const email = String(rawEmail || "").replace(/[`\'\"]/g, "").trim();
        const nickname = acc?.nickname ? String(acc.nickname).replace(/[`\'\"]/g, "").trim() : email;
        const domain = auth?.domain || (file.includes("-ai") ? "www.codebuddy.ai" : "copilot.tencent.com");

        upsertAccount({
          uid,
          email,
          nickname,
          accessToken: token || refreshToken,
          refreshToken: refreshToken || token,
          tokenType: auth?.tokenType || "Bearer",
          domain,
          region: domain.includes("codebuddy.ai") ? "overseas" : "domestic",
          expiresAt: auth?.expiresAt || null,
          refreshExpiresAt: auth?.refreshExpiresAt || null,
        }, { source: "local_scan" });
        count += 1;
      } catch {}
    }
  } catch {}
  return count;
}

function openExternal(targetUrl) {
  const parsed = new URL(targetUrl);
  const allowed = ["codebuddy.ai", "www.codebuddy.ai", "tencent.com", "copilot.tencent.com", "accounts.google.com", "github.com"];
  if (!allowed.some((d) => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`))) {
    throw new Error("不允许打开该外部地址");
  }
  let command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  let args = process.platform === "win32" ? ["/c", "start", "", targetUrl] : [targetUrl];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, version: VERSION, plugin: "workbuddy-switch" });
    }
    if (!authorized(req)) {
      return send(res, 401, { error: "unauthorized" });
    }
    log(`${req.method} ${url.pathname}`);

    if (req.method === "GET" && url.pathname === "/api/accounts") {
      // Auto import current CLI account if not already in store
      try {
        const cur = currentCliAccount();
        if (cur && cur.email) {
          const authData = readJson(AUTH_PATH);
          if (authData?.auth?.accessToken) {
            upsertAccount({
              uid: cur.uid,
              email: cur.email,
              nickname: cur.nickname,
              accessToken: authData.auth.accessToken,
              refreshToken: authData.auth.refreshToken,
              domain: authData.auth.domain || "www.codebuddy.ai",
              expiresAt: authData.auth.expiresAt,
            }, { source: "cli_auto_import" });
          }
        }
      } catch {}

      return send(res, 200, {
        current: currentCliAccount(),
        accounts: listAccounts(),
        config: configState,
        authPath: AUTH_PATH,
        backups: listBackups(AUTH_PATH).slice(0, 5),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/switch") {
      const body = await readBody(req);
      if (!body || !body.id) return send(res, 400, { error: "缺少账号 id" });
      return send(res, 200, startAsyncSwitch(body.id, "manual"));
    }

    if (req.method === "GET" && url.pathname === "/api/switch-status") {
      return send(res, 200, { switch: activeSwitch });
    }

    if (req.method === "POST" && url.pathname === "/api/rotate-now") {
      await checkAndAutoRotate();
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/settings") {
      const body = await readBody(req);
      if (body.autoRotate !== undefined) configState.autoRotate = Boolean(body.autoRotate);
      if (body.rotateIntervalMinutes) configState.rotateIntervalMinutes = Number(body.rotateIntervalMinutes);
      if (body.killCliOnSwitch !== undefined) configState.killCliOnSwitch = Boolean(body.killCliOnSwitch);
      saveState();
      setupRotationTimer();
      return send(res, 200, { ok: true, config: configState });
    }

    if (req.method === "POST" && url.pathname === "/api/login/start") {
      const body = await readBody(req);
      const domain = body.domain || (body.region === "domestic" ? "copilot.tencent.com" : "www.codebuddy.ai");
      return send(res, 200, await startOAuthLogin(domain));
    }

    if (req.method === "GET" && url.pathname === "/api/login/status") {
      return send(res, 200, { login: activeLogin });
    }

    if (req.method === "POST" && url.pathname === "/api/login/cancel") {
      if (activeLogin) activeLogin.status = "cancelled";
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/import-local") {
      const count = scanAndImportLocalAccounts();
      return send(res, 200, { ok: true, count, accounts: listAccounts() });
    }

    if (req.method === "POST" && url.pathname === "/api/import-token") {
      const body = await readBody(req);
      const token = (body.token || "").trim();
      const email = (body.email || "").trim();
      if (!token) return send(res, 400, { error: "请输入 Token 或 Refresh Token" });
      const acc = upsertAccount({
        email: email || `user_${Date.now()}`,
        refreshToken: token,
        accessToken: token,
        domain: body.domain || "www.codebuddy.ai",
      }, { source: "token_import" });
      return send(res, 200, { ok: true, account: sanitizeAccount(acc) });
    }

    if (req.method === "GET" && url.pathname === "/api/export") {
      const accounts = withStore((db) => db.prepare(`SELECT * FROM accounts`).all());
      const payload = {
        version: 1,
        provider: "codebuddy",
        exportedAt: nowIso(),
        accounts: accounts.map((a) => ({
          uid: a.uid,
          email: a.email,
          nickname: a.nickname,
          accessToken: a.access_token,
          refreshToken: a.refresh_token,
          tokenType: a.token_type,
          domain: a.domain,
          region: a.region,
          expiresAt: a.expires_at,
        })),
      };
      return send(res, 200, writeExportFile(payload));
    }

    if (req.method === "POST" && url.pathname === "/api/import-json") {
      const body = await readBody(req);
      const payload = safeJson(body.json || body);
      const list = Array.isArray(payload) ? payload : payload.accounts || [];
      let count = 0;
      for (const item of list) {
        if (!item.email && !item.uid) continue;
        upsertAccount({
          uid: item.uid,
          email: item.email || item.nickname,
          nickname: item.nickname,
          accessToken: item.accessToken || item.access_token || "",
          refreshToken: item.refreshToken || item.refresh_token || null,
          domain: item.domain || "www.codebuddy.ai",
        }, { source: "json_import" });
        count += 1;
      }
      return send(res, 200, { ok: true, imported: count });
    }

    if (req.method === "POST" && url.pathname === "/api/remove") {
      const body = await readBody(req);
      if (!body || !body.id) return send(res, 400, { error: "缺少 id" });
      withStore((db) => db.prepare(`DELETE FROM accounts WHERE id = ?`).run(body.id));
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/history") {
      return send(res, 200, { entries: listHistory(20) });
    }

    if (req.method === "POST" && url.pathname === "/api/open-folder") {
      const body = await readBody(req);
      openPath(body.path || EXPORT_DIR);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/open-url") {
      const body = await readBody(req);
      return send(res, 200, { ok: openExternal(body.url) });
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    log("request error:", err.message);
    send(res, 500, { error: err.message });
  }
});

loadState();
fs.mkdirSync(DATA_DIR, { recursive: true });
setupRotationTimer();

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  log(`v${VERSION} listening on http://127.0.0.1:${addr.port}`);
  log(`auth path:   ${AUTH_PATH}`);
  log(`db path:     ${DB_PATH}`);
  log(`auto-rotate: ${configState.autoRotate} (every ${configState.rotateIntervalMinutes}m)`);
});
