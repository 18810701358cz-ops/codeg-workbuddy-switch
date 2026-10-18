// WorkBuddy / CodeBuddy Switcher — plugin frontend.
//
// Self-contained ESM frontend registered to Codeg Plugin Host v2.
// Provides multi-account switching, auto-rotation control, quota/points monitoring,
// and OAuth/Token management for overseas and domestic CodeBuddy accounts.

const VERSION = "1.0.0";
const CSS = `
.wbs-root { font-size: 13px; color: var(--foreground); }
.wbs-card { border: 1px solid var(--border); border-radius: 10px; background: var(--card); overflow: hidden; }
.wbs-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.wbs-title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; }
.wbs-sub { color: var(--muted-foreground); font-size: 12px; margin-top: 2px; }
.wbs-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wbs-btn { appearance: none; border: 1px solid var(--border); background: transparent; color: var(--foreground); border-radius: 7px; padding: 4px 10px; font-size: 12px; cursor: pointer; transition: background .15s ease; }
.wbs-btn:hover { background: var(--accent); }
.wbs-btn:disabled { opacity: .45; cursor: default; }
.wbs-btn.primary { background: var(--primary); color: var(--primary-foreground); border-color: transparent; }
.wbs-btn.primary:hover { filter: brightness(1.05); }
.wbs-btn.danger { color: #dc2626; border-color: color-mix(in oklab, #dc2626 30%, var(--border)); }
.wbs-btn.danger:hover { background: color-mix(in oklab, #dc2626 15%, transparent); }
.wbs-bar-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 9px 14px; border-bottom: 1px solid var(--border); background: color-mix(in oklab, var(--card) 95%, var(--primary) 5%); }
.wbs-badge { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px; font-size: 11px; color: var(--muted-foreground); }
.wbs-badge.on { color: #16a34a; border-color: color-mix(in oklab, #16a34a 40%, var(--border)); background: color-mix(in oklab, #16a34a 10%, transparent); }
.wbs-badge.warn { color: #d97706; border-color: color-mix(in oklab, #d97706 40%, var(--border)); background: color-mix(in oklab, #d97706 10%, transparent); }
.wbs-badge.region-overseas { color: #0284c7; border-color: color-mix(in oklab, #0284c7 40%, var(--border)); }
.wbs-badge.region-domestic { color: #dc2626; border-color: color-mix(in oklab, #dc2626 40%, var(--border)); }
.wbs-list { display: flex; flex-direction: column; }
.wbs-row { display: grid; grid-template-columns: 1fr auto; gap: 12px; padding: 12px 14px; border-top: 1px solid var(--border); align-items: center; }
.wbs-row:first-child { border-top: 0; }
.wbs-row.active { background: color-mix(in oklab, var(--primary) 6%, transparent); }
.wbs-email { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
.wbs-meta { color: var(--muted-foreground); font-size: 12px; margin-top: 4px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.wbs-history { border-top: 1px solid var(--border); }
.wbs-history-title { padding: 9px 14px 6px; font-size: 11px; font-weight: 600; color: var(--muted-foreground); letter-spacing: .03em; }
.wbs-history-row { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; padding: 5px 14px; font-size: 11px; color: var(--muted-foreground); }
.wbs-history-row:last-child { padding-bottom: 10px; }
.wbs-history-email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--foreground); }
.wbs-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); color: var(--muted-foreground); font-size: 11px; }
.wbs-empty { padding: 24px 14px; text-align: center; color: var(--muted-foreground); }
.wbs-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted-foreground); flex: 0 0 auto; }
.wbs-dot.on { background: #22c55e; }
.wbs-dot.warn { background: #f59e0b; }
.wbs-dot.err { background: #ef4444; }
.wbs-status-btn { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--muted-foreground); padding: 2px 7px; border-radius: 6px; cursor: pointer; font-size: 12px; }
.wbs-status-btn:hover { background: var(--accent); color: var(--foreground); }
.wbs-overlay { position: fixed; inset: 0; z-index: 2147483000; background: rgba(0,0,0,.38); display: flex; align-items: center; justify-content: center; padding: 16px; }
.wbs-modal { width: min(640px, calc(100vw - 32px)); max-height: min(80vh, 760px); display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 12px; background: var(--card); color: var(--foreground); box-shadow: 0 24px 64px rgba(0,0,0,.32); overflow: hidden; }
.wbs-modal-body { padding: 16px; display: flex; flex-direction: column; gap: 14px; overflow: auto; }
`;

const plugin = {
  ctx: null,
  data: null,
  history: [],
  loading: false,
  error: null,
  switching: null,
  listeners: new Set(),
  modal: null,
  disposed: false,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function subscribe(fn) {
  plugin.listeners.add(fn);
  return () => plugin.listeners.delete(fn);
}

function notify() {
  for (const fn of [...plugin.listeners]) {
    try {
      fn();
    } catch {}
  }
}

async function api(path, init) {
  const res = await plugin.ctx.backend.fetch(path, init);
  let data = null;
  try {
    data = JSON.parse(res.body);
  } catch {}
  if (res.status < 200 || res.status >= 300) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data;
}

async function ensureBackend() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await plugin.ctx.backend.fetch("/health");
      if (res.status === 200) return;
    } catch {}
    await sleep(200);
  }
  throw new Error("后端服务未启动");
}

async function refresh() {
  if (plugin.loading) return;
  plugin.loading = true;
  plugin.error = null;
  notify();
  try {
    await ensureBackend();
    const [accs, hist] = await Promise.allSettled([
      api("/api/accounts"),
      api("/api/history"),
    ]);
    if (accs.status === "fulfilled") {
      plugin.data = accs.value;
    } else {
      plugin.error = accs.reason?.message || "读取账号失败";
    }
    if (hist.status === "fulfilled") {
      plugin.history = hist.value.entries || [];
    }
  } catch (err) {
    plugin.error = err.message;
  } finally {
    plugin.loading = false;
    notify();
  }
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortEmail(email) {
  if (!email) return "";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

function currentCli() {
  return plugin.data?.current || null;
}

async function waitForSwitch(switchId) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await sleep(1500);
    let data;
    try {
      data = await api("/api/switch-status");
    } catch {
      continue;
    }
    const cur = data?.switch;
    if (!cur || cur.id !== switchId) return { status: "unknown" };
    if (cur.status !== "running") return cur;
  }
  throw new Error("切换超时");
}

async function switchTo(account) {
  if (plugin.switching) return;
  plugin.switching = account.id;
  notify();
  try {
    const started = await api("/api/switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: account.id }),
    });
    plugin.ctx.notify(`正在切换至 ${account.email}...`, "info");
    const final = await waitForSwitch(started.switchId);
    if (final.status === "error") throw new Error(final.error || "切换失败");
    plugin.ctx.notify(`已切换 CLI 账号至 ${account.email}`, "success");
    await refresh();
  } catch (err) {
    plugin.ctx.notify(`切号失败：${err.message}`, "error");
  } finally {
    plugin.switching = null;
    notify();
  }
}

async function rotateNow() {
  try {
    plugin.ctx.notify("正在检测各账号临期积分与限额...", "info");
    await api("/api/rotate-now", { method: "POST" });
    await refresh();
    plugin.ctx.notify("轮换检测已完成", "success");
  } catch (err) {
    plugin.ctx.notify(`轮换检测失败：${err.message}`, "error");
  }
}

async function toggleAutoRotate() {
  const current = Boolean(plugin.data?.config?.autoRotate);
  try {
    await api("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoRotate: !current }),
    });
    plugin.ctx.notify(!current ? "已开启 CLI 自动轮换（临期优先）" : "已关闭 CLI 自动轮换", "info");
    await refresh();
  } catch (err) {
    plugin.ctx.notify(`更新设置失败：${err.message}`, "error");
  }
}

function showAddModal() {
  const overlay = el("div", "wbs-overlay");
  const modal = el("div", "wbs-modal");

  const head = el("div", "wbs-head");
  const title = el("div", "wbs-title", "添加 CodeBuddy 账号");
  const close = el("button", "wbs-btn", "关闭");
  head.append(title, close);

  const body = el("div", "wbs-modal-body");

  // Tab switch: Overseas vs Domestic vs Paste Token
  const desc = el("div", "wbs-sub", "选择添加方式：支持海外版（Google / GitHub 授权）或直接粘贴 Token。");
  body.appendChild(desc);

  const btnRow = el("div", "wbs-actions");
  const overseasBtn = el("button", "wbs-btn primary", "🌐 登录海外版 (codebuddy.ai)");
  const domesticBtn = el("button", "wbs-btn", "🇨🇳 登录国内版 (copilot.tencent.com)");
  btnRow.append(overseasBtn, domesticBtn);
  body.appendChild(btnRow);

  const statusBox = el("div", "wbs-sub");
  statusBox.style.minHeight = "24px";
  body.appendChild(statusBox);

  let activeLoginId = null;
  let timer = null;

  async function startLogin(domain) {
    try {
      statusBox.textContent = "正在获取授权登录链接...";
      const res = await api("/api/login/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      activeLoginId = res.id;
      statusBox.textContent = "已就绪，正在打开浏览器完成授权...";

      // Poll
      timer = setInterval(async () => {
        try {
          const check = await api("/api/login/status");
          const l = check?.login;
          if (l?.authUrl && !l._opened) {
            l._opened = true;
            await api("/api/open-url", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ url: l.authUrl }),
            });
          }
          if (l?.status === "success") {
            clearInterval(timer);
            plugin.ctx.notify(`成功添加账号：${l.account?.email}`, "success");
            overlay.remove();
            await refresh();
          } else if (l?.status === "error") {
            clearInterval(timer);
            statusBox.textContent = `登录失败：${l.error}`;
            statusBox.style.color = "#dc2626";
          }
        } catch {}
      }, 1500);
    } catch (err) {
      statusBox.textContent = `启动失败：${err.message}`;
      statusBox.style.color = "#dc2626";
    }
  }

  overseasBtn.addEventListener("click", () => startLogin("www.codebuddy.ai"));
  domesticBtn.addEventListener("click", () => startLogin("copilot.tencent.com"));

  // Paste Token Section
  const tokenTitle = el("div", "wbs-title", "或者：直接粘贴 Token / RefreshToken");
  tokenTitle.style.fontSize = "12px";
  tokenTitle.style.marginTop = "10px";
  const emailInput = el("input");
  emailInput.placeholder = "账号邮箱或备注 (选填)";
  emailInput.style.padding = "6px 8px";
  emailInput.style.borderRadius = "6px";
  emailInput.style.border = "1px solid var(--border)";
  emailInput.style.background = "var(--input)";
  emailInput.style.color = "var(--foreground)";

  const tokenInput = el("input");
  tokenInput.placeholder = "粘贴 access_token 或 refresh_token";
  tokenInput.style.padding = "6px 8px";
  tokenInput.style.borderRadius = "6px";
  tokenInput.style.border = "1px solid var(--border)";
  tokenInput.style.background = "var(--input)";
  tokenInput.style.color = "var(--foreground)";

  const submitTokenBtn = el("button", "wbs-btn", "添加此 Token");
  submitTokenBtn.addEventListener("click", async () => {
    try {
      await api("/api/import-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: emailInput.value, token: tokenInput.value }),
      });
      plugin.ctx.notify("Token 账号已录入", "success");
      overlay.remove();
      await refresh();
    } catch (err) {
      plugin.ctx.notify(`录入失败：${err.message}`, "error");
    }
  });

  body.append(tokenTitle, emailInput, tokenInput, submitTokenBtn);
  modal.append(head, body);
  overlay.append(modal);

  close.addEventListener("click", () => {
    if (timer) clearInterval(timer);
    overlay.remove();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      if (timer) clearInterval(timer);
      overlay.remove();
    }
  });

  document.body.appendChild(overlay);
}

async function exportJson() {
  try {
    const res = await api("/api/export");
    plugin.ctx.notify(`已导出至 ${res.filename}`, "success");
    await api("/api/open-folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: res.path }),
    });
  } catch (err) {
    plugin.ctx.notify(`导出失败：${err.message}`, "error");
  }
}

async function importJson() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.style.display = "none";
  document.body.appendChild(input);

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const text = await file.text();
      const res = await api("/api/import-json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: text }),
      });
      plugin.ctx.notify(`已导入 ${res.imported || 0} 个账号`, "success");
      await refresh();
    } catch (err) {
      plugin.ctx.notify(`导入失败：${err.message}`, "error");
    }
  });
  input.click();
}

function renderRow(account) {
  const row = el("div", "wbs-row");
  const isCurrent = account.isCliActive;
  if (isCurrent) row.classList.add("active");

  const left = el("div");
  const emailLine = el("div", "wbs-email");
  emailLine.textContent = account.email || account.nickname;
  if (account.region === "overseas") {
    emailLine.appendChild(el("span", "wbs-badge region-overseas", "🌐 海外版"));
  } else {
    emailLine.appendChild(el("span", "wbs-badge region-domestic", "🇨🇳 国内版"));
  }
  if (isCurrent) {
    emailLine.appendChild(el("span", "wbs-badge on", "CLI 当前"));
  }
  left.appendChild(emailLine);

  const meta = el("div", "wbs-meta");
  if (account.nickname && account.nickname !== account.email) {
    meta.appendChild(el("span", null, `昵称: ${account.nickname}`));
  }
  if (account.pointsBalance != null) {
    meta.appendChild(el("span", "wbs-badge", `积分: ${account.pointsBalance}`));
  }
  if (account.pointsExpiresAt) {
    meta.appendChild(el("span", "wbs-badge warn", `积分到期: ${formatDateTime(account.pointsExpiresAt)}`));
  }
  if (account.lastUsed) {
    meta.appendChild(el("span", null, `上次使用: ${formatDateTime(account.lastUsed)}`));
  }
  left.appendChild(meta);

  const actions = el("div", "wbs-actions");
  const switchBtn = el("button", "wbs-btn", isCurrent ? "当前激活" : "设为当前 CLI");
  switchBtn.disabled = isCurrent || plugin.switching === account.id;
  if (!isCurrent) switchBtn.classList.add("primary");
  switchBtn.addEventListener("click", () => switchTo(account));

  const delBtn = el("button", "wbs-btn danger", "删除");
  delBtn.addEventListener("click", async () => {
    if (!confirm(`确认删除账号 ${account.email}？`)) return;
    try {
      await api("/api/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: account.id }),
      });
      plugin.ctx.notify("账号已移除", "info");
      await refresh();
    } catch (err) {
      plugin.ctx.notify(`删除失败：${err.message}`, "error");
    }
  });

  actions.append(switchBtn, delBtn);
  row.append(left, actions);
  return row;
}

function renderList(container) {
  container.textContent = "";
  const accounts = plugin.data?.accounts || [];
  if (!accounts.length) {
    container.appendChild(el("div", "wbs-empty", "暂无 CodeBuddy 账号，点击上方「+ 添加账号」开始使用。"));
    return;
  }
  for (const acc of accounts) {
    container.appendChild(renderRow(acc));
  }
}

function buildHeader() {
  const head = el("div", "wbs-head");
  const left = el("div");
  left.appendChild(el("div", "wbs-title", "CodeBuddy 自动换号器"));
  const cur = currentCli();
  left.appendChild(
    el("div", "wbs-sub", cur ? `当前 CLI 凭据：${cur.email}` : "未检测到本地 CLI 凭据")
  );

  const actions = el("div", "wbs-actions");
  const refreshBtn = el("button", "wbs-btn", plugin.loading ? "刷新中..." : "刷新");
  refreshBtn.disabled = plugin.loading;
  refreshBtn.addEventListener("click", refresh);

  actions.append(refreshBtn);
  head.append(left, actions);
  return head;
}

function buildAutoRotateBar() {
  const bar = el("div", "wbs-bar-actions");
  const auto = Boolean(plugin.data?.config?.autoRotate);
  const left = el("div", null);
  left.style.display = "flex";
  left.style.alignItems = "center";
  left.style.gap = "8px";

  const badge = el(
    "span",
    `wbs-badge ${auto ? "on" : "warn"}`,
    auto ? "🟢 自动轮换开启 (临期积分优先)" : "⚪ 自动轮换已关闭"
  );
  left.appendChild(badge);

  const actions = el("div", "wbs-actions");
  const toggleBtn = el("button", "wbs-btn", auto ? "关闭轮换" : "开启轮换");
  toggleBtn.addEventListener("click", toggleAutoRotate);

  const rotateBtn = el("button", "wbs-btn", "⚡ 立即检测");
  rotateBtn.title = "立即扫描各账号积分与到期时间并执行换号";
  rotateBtn.addEventListener("click", rotateNow);

  const addBtn = el("button", "wbs-btn primary", "+ 添加账号");
  addBtn.addEventListener("click", showAddModal);

  const importBtn = el("button", "wbs-btn", "导入 JSON");
  importBtn.addEventListener("click", importJson);

  const exportBtn = el("button", "wbs-btn", "导出 JSON");
  exportBtn.addEventListener("click", exportJson);

  actions.append(toggleBtn, rotateBtn, addBtn, importBtn, exportBtn);
  bar.append(left, actions);
  return bar;
}

function buildHistory() {
  const sec = el("div", "wbs-history");
  sec.appendChild(el("div", "wbs-history-title", "最近切换与轮换记录"));
  const entries = plugin.history.slice(0, 10);
  if (!entries.length) {
    sec.appendChild(el("div", "wbs-empty", "暂无切换记录"));
    return sec;
  }
  for (const item of entries) {
    const row = el("div", "wbs-history-row");
    const reasonTag =
      item.reason === "auto_rotation_urgency"
        ? "[自动轮换:临期]"
        : item.reason === "auto_rotation_quota"
          ? "[自动轮换:限额]"
          : "[手动切换]";
    const tag = el("span", "wbs-badge", reasonTag);
    const label = item.fromEmail && item.fromEmail !== item.email
      ? `${item.fromEmail} → ${item.email}`
      : item.email;
    const text = el("span", "wbs-history-email", label);
    const time = el("span", null, formatDateTime(item.at));
    row.append(tag, text, time);
    sec.appendChild(row);
  }
  return sec;
}

function buildFooter() {
  const foot = el("div", "wbs-foot");
  foot.appendChild(el("div", null, `凭据路径: ${plugin.data?.authPath || ""}`));
  foot.appendChild(el("div", null, `v${VERSION}`));
  return foot;
}

function buildCard() {
  const card = el("div", "wbs-card");
  card.appendChild(buildHeader());
  card.appendChild(buildAutoRotateBar());

  const list = el("div", "wbs-list");
  renderList(list);
  card.appendChild(list);

  card.appendChild(buildFooter());
  card.appendChild(buildHistory());
  return card;
}

function mountSettings(host) {
  const root = el("div", "wbs-root");
  host.appendChild(root);

  const render = () => {
    root.textContent = "";
    root.appendChild(buildCard());
  };

  const unsubscribe = subscribe(render);
  render();
  if (!plugin.data && !plugin.loading) refresh();
  return () => {
    unsubscribe();
    root.remove();
  };
}

function openModal() {
  if (plugin.modal) return;
  const overlay = el("div", "wbs-overlay");
  const modal = el("div", "wbs-modal");
  overlay.appendChild(modal);

  const render = () => {
    modal.textContent = "";
    modal.appendChild(buildCard());
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      unsubscribe();
      overlay.remove();
      plugin.modal = null;
    }
  });

  const unsubscribe = subscribe(render);
  render();
  document.body.appendChild(overlay);
  plugin.modal = overlay;
  if (!plugin.data && !plugin.loading) refresh();
}

function mountStatus(host) {
  const root = el("div");
  const button = el("button", "wbs-status-btn");
  button.title = "点击打开 CodeBuddy 自动换号器";
  button.addEventListener("click", openModal);
  root.appendChild(button);
  host.appendChild(root);

  const render = () => {
    const cur = currentCli();
    button.textContent = "";
    const dot = el("span", `wbs-dot ${cur ? "on" : "warn"}`);
    const text = el("span", null, `CB ${cur ? shortEmail(cur.email) : "未登录"}`);
    button.append(dot, text);
  };

  const unsubscribe = subscribe(render);
  render();
  return () => {
    unsubscribe();
    root.remove();
  };
}

export async function activate(ctx) {
  plugin.ctx = ctx;
  plugin.disposed = false;
  ctx.injectCSS(CSS);

  ctx.registerSlot("statusbar.right", {
    id: "workbuddy-switch-status",
    order: 25,
    mount: mountStatus,
  });

  ctx.registerSlot("settings.plugin-detail", {
    id: "workbuddy-switch-panel",
    order: 15,
    mount: mountSettings,
  });

  ctx.logger?.info(`workbuddy-switch v${VERSION} activated`);
}

export function deactivate() {
  plugin.disposed = true;
  if (plugin.modal) {
    plugin.modal.remove();
    plugin.modal = null;
  }
}
