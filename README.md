# CodeBuddy 自动换号器 (WorkBuddy Switcher)

专为 **CodeBuddy CLI** 与 **WorkBuddy / CodeBuddy IDE** 打造的多账号管理与自动换号器。深度移植并融合了开源项目 `changexbc/workbuddy-switch` 的核心特性，原生支持**海外版（国际版）与国内版**，具备积分临期优先的 CLI 自动轮换能力。

---

## 核心特性

### 1. 深度支持海外版（国际版）
* **端点适配**：原生支持海外版 API 端点（`https://www.codebuddy.ai`）及国内版端点（`https://copilot.tencent.com`）。
* **浏览器 OAuth 登录**：支持海外版 Google / GitHub 账号一键授权登录，自动完成 Token 交换与 profile 获取。
* **直接凭据导入**：支持直接粘贴海外版的 Access Token 或 Refresh Token，快速完成账号入库。

### 2. CodeBuddy CLI 自动轮换（Auto-Rotation）
* **临期积分优先**：后台守护任务定期检测各账号的积分到期时间，优先将积分即将到期的账号设为 CLI 当前默认激活账号，彻底解决积分过期浪费问题。
* **限额与到期无感切号**：当激活账号积分耗尽或到期时，系统自动切换至下一个可用账号。
* **安全进程接管**：在切换 CLI 账号时，自动检测并结束旧的 `codebuddy.exe` / `cb.exe` 进程，确保终端执行新命令时立即加载新登录态。
* **手动即时检测**：面板提供「⚡ 立即检测」按钮，随时触发全量账号积分扫描与轮换策略。

### 3. 多账号管理与凭据安全
* **凭据原子写入**：自动更新 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\Tencent-Cloud.coding-copilot.info` 及 `~/.codebuddy/settings.json`。
* **历史快照备份与一键还原**：每次切换前自动创建带有时间戳的快照文件（保留最近 10 次），支持一键恢复。
* **账号池 JSON 导入导出**：支持一键将账号池导出至本地安全文件，并在多台设备间快速导入。
* **Token 自动保活**：在切号及后台巡检时自动调用官方刷新接口更新 Access Token。

### 4. 切换与轮换审计记录
* 完整记录每次切号时间、来源账号、目标账号、触发原因（`[手动切换]`、`[自动轮换:临期]`、`[自动轮换:限额]`）以及执行结果。

---

## 配置说明

在 Codeg 的「设置 -> 插件 -> CodeBuddy 自动换号器」中可配置以下参数：

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `endpoint` | API 服务端点（海外版或国内版） | `https://www.codebuddy.ai` |
| `authPath` | CLI 登录凭据路径 | `%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info` |
| `autoRotate` | 是否开启 CLI 自动轮换（临期优先） | `true` |
| `rotateIntervalMinutes` | 自动轮换检测周期（分钟） | `5` |
| `killCliOnSwitch` | 切号时是否自动结束旧 CLI 进程 | `true` |
| `autoReconnect` | 切号后是否尝试重连工作区会话 | `true` |

---

## 测试与验证

项目包含端到端后端测试与前端测试：

```bash
node --test test/backend.test.mjs test/frontend.test.mjs
```
