# DSH Context Console

[![npm](https://img.shields.io/npm/v/dsh-context-console)](https://www.npmjs.com/package/dsh-context-console)
[![CI](https://github.com/anweat/dsh-context-console/actions/workflows/ci.yml/badge.svg)](https://github.com/anweat/dsh-context-console/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-context-console)](./LICENSE)

面向 DeepSeek Harness 的完整上下文工作台：把会话轨迹、Prompt / Skill /
MCP / Tools 管理、缓存观察、消息锻造和 sessionlog 修复放进同一个插件。

> [!IMPORTANT]
> `dsh-context-console` 是
> [`dsh-assistant-message-forge`](https://github.com/anweat/dsh-assistant-message-forge)
> 的正式继任者。消息锻造台已停止功能更新；它的完整能力、RPC 兼容层和原有
> 数据目录均由本插件继续维护。迁移步骤见 [MIGRATION.md](./MIGRATION.md)。

![上下文轨迹砖块墙](./docs/images/context-console-trajectory.png)

## 能力

| 工作区 | 能力 |
|---|---|
| 轨迹砖块墙 | 展示 user、assistant、reasoning、tool call/result、request header 等会话事件；支持展开、过滤与行内编辑 |
| 分类管理 | 双栏管理 Prompt、Skill、MCP 与 Tools；支持拖拽上线/下线和 Prompt 插入位置选择 |
| 缓存与历史 | 跟踪 request header 变化、cache read token 和管理动作，持久化到 SQLite 历史流 |
| 模拟消息 | 注入 Assistant、User、Tool Call、Tool Result 或原始 JSON 事件 |
| 消息锻造 | 保留草稿、详细上下文卡片、surface replace、导入识别与直接注入能力 |
| 会话修复 | 识别 JSONL/Zstandard sessionlog，采用“后写分支覆盖 + 官方 crash closer + Session.create 校验”创建修复子会话，绝不改写源日志 |
| 子代理轨迹 | 识别 subagent tool call/result，并在可获得子会话 ID 时嵌套展示轨迹 |

![Prompt、Skill、MCP 与 Tools 分类管理](./docs/images/context-console-inventory.png)

![继承的消息锻造与 sessionlog 修复工作区](./docs/images/context-console-forge.png)

## 兼容版本

| 插件发布通道 | DSH 基线 | 兼容承诺 |
|---|---|---|
| npm `latest`（当前正式发布插件） | `dsh-v0.1.1-rc.2` | 已验证维护基线 |
| npm `next` 候选（`0.1.1-alpha.5`） | `dsh-v0.1.5-alpha.1` | 适配 Session Log V3；通过构建、包测试与隔离真实 profile 门禁后发布 |
| 后续 DSH 正式版 `0.1.2` | 尚未发布 | 发布并完成真实 profile 门禁后再声明兼容 |

开发版不会覆盖 npm `latest`。alpha.5 依赖按 `0.1.5-alpha.1` 精确锁定；继续使用
`snapshotEvents()`、`SessionSeq` 和 `SessionLogOffset`，并验证 Session Log V3 的历史内容迁移与投影读取，
不会混装 rc.2 或早期 alpha 运行时。

- Node.js：`^22.19.0 || >=24.0.0`
- pnpm：`11.7.0`（建议始终通过 Corepack 调用）

DSH 当前仍处于快速、破坏性演进阶段。本插件按上述发布通道声明兼容，不把开发版
验证结果提前扩展到尚未发布的正式版。

## 安装

```powershell
corepack pnpm dsh plugin --profile web add dsh-context-console
```

如果正在使用消息锻造台，请一次性完成替换，避免两个插件注册相同的兼容 RPC：

```powershell
corepack pnpm dsh plugin --profile web remove dsh-assistant-message-forge
corepack pnpm dsh plugin --profile web add dsh-context-console
```

随后重启 DSH。原有 `$DSH_HOME/assistant-message-forge/` 数据会直接复用，无需转换。

发布包的 `repository` 元数据指向本仓库；可通过 npm registry 核对版本与完整性：

```powershell
npm view dsh-context-console version dist.integrity repository
```

## 本地开发

```powershell
git clone https://github.com/anweat/dsh-context-console.git
cd dsh-context-console
corepack pnpm install --frozen-lockfile
corepack pnpm run verify
```

安装本地检出版本：

```powershell
corepack pnpm dsh plugin --profile web add D:/codeproject/dsh-context-console
```

## 架构

```mermaid
flowchart LR
  UI[DSH conversation views] --> RPC1[/api/dsh-context-console/*]
  UI --> RPC2[/api/dsh-assistant-message-forge/*]
  RPC1 --> Console[Trajectory / Inventory / Cache / History]
  RPC2 --> Forge[Drafts / Context Cards / Import / Repair]
  Console --> Session[(Live Session Log)]
  Forge --> Session
  Console --> Store[(context-console storage)]
  Forge --> Legacy[(assistant-message-forge data)]
```

Host 和 Client 通过 DSH Connection 的认证 `/api` 精确路由协作；浏览器 bundle 只依赖 DSH 冻结的
模块表。0.1.5 起 Connection 可先于 WebServer 存在，因此插件通过 exact Fetch registry
挂载路由，不占用共享 RPC interceptor。Message Forge 保留端点语义和数据目录，为既有用户提供无数据转换迁移。

## RPC

### `/api/dsh-context-console/*`

- `overview`
- `trajectory/list`
- `inventory/list`
- `inventory/activate`
- `inventory/deactivate`
- `inventory/setInsertion`
- `message/edit`
- `sim/inject`
- `cache/overview`
- `history/list`
- `history/clear`
- `state/export`
- `state/import`

### `/api/dsh-assistant-message-forge/*`（兼容层）

- `drafts/list` / `drafts/save` / `drafts/delete`
- `session/inject`
- `context/load` / `context/refresh` / `context/apply`
- `records/update` / `records/reset`
- `sessionlog/parse`
- `sessionlog/repair-preview`
- `sessionlog/repair-create`

## 数据与安全边界

| 内容 | 路径 |
|---|---|
| Context Console 配置 | `$DSH_HOME/context-console/manifest.json` |
| 历史与缓存事件 | `$DSH_HOME/context-console/history.sqlite` |
| 继承的草稿与上下文记录 | `$DSH_HOME/assistant-message-forge/` |

- RPC 复用 DSH Connection 的 Host/Origin 栅栏和浏览器认证；插件不再维护独立授权策略。
- MCP 配置可能包含环境变量或请求头；导出状态前应自行检查敏感字段。
- sessionlog 修复只创建带 `parentSession` 的新会话，不覆盖或截断来源文件。
- 正在执行、存在未闭合 turn 的会话拒绝消息注入和 surface replace。

## 许可证

[MIT](./LICENSE)
