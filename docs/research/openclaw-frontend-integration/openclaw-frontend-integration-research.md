# OpenClaw Agent 前端对接技术调研报告

> 调研日期: 2026-07-06
> 目标: 评估将 openclaw-integration 作为后端，在 agent-frontend 中实现类似 OpenWork / AIonUI 的前端交互模式

---

## 目录

1. [第一性原理：问题的本质](#1-第一性原理问题的本质)
2. [OpenClaw 后端能力全景](#2-openclaw-后端能力全景)
3. [参考项目对比分析](#3-参考项目对比分析)
4. [前端框架选型](#4-前端框架选型)
5. [对接协议方案](#5-对接协议方案)
6. [产物上传下载方案](#6-产物上传下载方案)
7. [Agent / Subagent 交互展示方案](#7-agent--subagent-交互展示方案)
8. [会话管理方案](#8-会话管理方案)
9. [定时任务管理方案](#9-定时任务管理方案)
10. [可行性评估与实施路线](#10-可行性评估与实施路线)

---

## 1. 第一性原理：问题的本质

### 1.1 要解决的核心问题

我们需要构建一个 Web 前端，使其能够：

```
用户 → [Web UI] → [OpenClaw Agent 后端] → [LLM + 工具 + 子代理]
     ↑                                          ↓
     ←←← 实时流式回传（文本/工具调用/产物/状态）←←←
```

### 1.2 分解为原子问题

| #   | 原子问题           | 本质约束                                                                                                                                      |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **前端框架选择**   | agent-frontend 已有 React 19 + Vite 7 + Radix UI + Tailwind CSS v4 技术栈，且包含 16 个业务模块。不应推翻重建，应在其基础上扩展               |
| P2  | **前后端通信协议** | OpenClaw 同时提供 WebSocket 网关协议、OpenAI 兼容 API、Open Responses API 三种接口。需评估哪种最适合多 chat + 代码执行 + 定时任务的需求       |
| P3  | **多会话管理**     | OpenClaw 已有完整的 session-key 路由系统 (`agent:{agentId}:{mainKey}`) 和 `sessions_list`/`sessions_history`/`sessions_send` 工具             |
| P4  | **文件操作**       | OpenClaw 有 media server (`/media/:id`)、artifact jobs (inbox/outbox 模型)、文件工具 (read/write/edit/apply_patch/exec)。前端需展示和下载产物 |
| P5  | **代码执行展示**   | OpenClaw 有 `exec`/`process` 工具和 `before_tool_call`/`after_tool_call` 钩子。前端需展示执行过程和结果                                       |
| P6  | **Subagent 交互**  | OpenClaw 有完整的 subagent 系统（spawn/announce/lifecycle events）。前端需展示子代理运行状态和结果                                            |
| P7  | **定时任务**       | OpenClaw 有完整的 cron 系统（add/list/update/remove/run + CLI + agent tool）。前端需提供管理 UI                                               |

### 1.3 第一性原理推导

**核心洞察**: OpenClaw 不是一个简单的 LLM API 代理，而是一个完整的 local-first AI gateway。它已经具备：

- 会话路由与管理
- 工具执行与审批
- 子代理编排
- 定时任务
- 多渠道适配
- 产物处理

因此，前端的核心任务不是"实现这些功能"，而是"**将 OpenClaw 已有的后端能力以优秀的 UI 呈现出来**"。这决定了：

1. **不需要自研通信协议** — OpenClaw 已有 WebSocket 网关协议，覆盖所有功能
2. **不需要重建后端逻辑** — 会话、工具、子代理、定时任务均已有后端实现
3. **核心挑战是协议适配层** — 将 OpenClaw 的 WebSocket 帧协议适配为前端可消费的 React 状态

---

## 2. OpenClaw 后端能力全景

### 2.1 三种对外接口

OpenClaw 网关同时提供三种对外接口，能力逐层递增：

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                             │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │  /openai/*   │  │ /openresp/*  │  │  WebSocket Gateway     │ │
│  │  (Chat API)  │  │ (Responses)  │  │  (Full Features)       │ │
│  │              │  │              │  │                        │ │
│  │  • 对话      │  │  • 对话      │  │  • 对话 + 流式          │ │
│  │  • SSE 流式  │  │  • SSE 流式  │  │  • 工具调用             │ │
│  │  • 无工具    │  │  • 工具调用  │  │  • 会话管理             │ │
│  │  • 无会话    │  │  • 文件输入  │  │  • 子代理管理           │ │
│  │              │  │              │  │  • 定时任务             │ │
│  │              │  │              │  │  • 配置管理             │ │
│  │              │  │              │  │  • 设备配对认证         │ │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬───────────┘ │
│         │                 │                      │             │
│         ▼                 ▼                      ▼             │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Agent Runtime + Tool System                 │  │
│  │  26+ 工具 | 4 profiles | 24 hooks | 循环检测 | 审批     │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

| 接口                  | 协议         | 能力范围                       | 适合场景                 |
| --------------------- | ------------ | ------------------------------ | ------------------------ |
| `/openai/*`           | HTTP + SSE   | 仅对话流式，无工具/会话/子代理 | 简单聊天 UI、第三方集成  |
| `/openresponses/*`    | HTTP + SSE   | 对话 + 工具调用 + 文件输入     | 需要 tool calling 的应用 |
| **WebSocket Gateway** | WS (JSON 帧) | **全部能力**                   | **完整前端 UI（推荐）**  |

### 2.2 WebSocket 网关协议详解

这是 OpenClaw 的原生协议，覆盖所有功能：

**连接流程**:

```
Client                          Server
  │                               │
  ├── WS Connect ────────────────►│
  │                               │
  │◄── connect.challenge ─────────┤  (nonce)
  │                               │
  ├── connect (signed) ─────────►│  (Ed25519 签名)
  │                               │
  │◄── hello-ok ──────────────────┤  (snapshot, features, deviceToken)
  │                               │
  ├── req: chat.send ────────────►│
  │                               │
  │◄── event: chat (streaming) ───┤  (seq: 1, 2, 3... state: final)
  │                               │
  ├── req: sessions.list ────────►│
  │                               │
  │◄── res: sessions list ────────┤
  │                               │
  ├── req: cron.list ────────────►│
  │                               │
  │◄── res: cron jobs ────────────┤
  │                               │
```

**帧类型**:

```typescript
// 请求帧 (Client → Server)
{ type: "req", id: "uuid", method: "chat.send", params: { ... } }

// 响应帧 (Server → Client)
{ type: "res", id: "uuid", result: { ... } }  // 或 { error: { ... } }

// 事件帧 (Server → Client, 推送)
{ type: "event", event: "chat", data: { runId, sessionKey, seq, state, message } }
```

**核心网关方法**:

| 方法组       | 方法                                                                  | 用途                                   |
| ------------ | --------------------------------------------------------------------- | -------------------------------------- |
| **Chat**     | `chat.send` / `chat.history` / `chat.abort` / `chat.inject`           | 发送消息、获取历史、中止运行、注入消息 |
| **Sessions** | `sessions.list` / `sessions.patch` / `sessions.delete`                | 会话列表、更新、删除                   |
| **Cron**     | `cron.list` / `cron.add` / `cron.update` / `cron.remove` / `cron.run` | 定时任务全生命周期                     |
| **Config**   | `config.get` / `config.schema` / `config.apply` / `config.patch`      | 配置读写                               |
| **Agent**    | `agent` / `agents.list`                                               | 启动 agent 运行、列出 agents           |
| **Models**   | `models`                                                              | 可用模型列表                           |
| **Health**   | `health` / `system` / `logs`                                          | 系统状态                               |
| **Devices**  | `devices.list` / `devices.pair.*`                                     | 设备管理                               |
| **Exec**     | `execApprovals.*`                                                     | 工具执行审批                           |
| **Browser**  | `browser.*`                                                           | 浏览器控制                             |

**Chat 流式事件**:

```typescript
{
  event: "chat",
  data: {
    runId: string,         // 运行 ID
    sessionKey: string,    // 会话键 "agent:main:main"
    seq: number,           // 序列号 (单调递增)
    state: "streaming" | "final" | "error" | "aborted",
    message: {             // 增量消息
      role: "assistant",
      content: "...",      // 文本增量
      toolCalls?: [...],   // 工具调用
      thinking?: "...",    // 推理过程
    }
  }
}
```

### 2.3 Agent 事件流

OpenClaw 内部有完整的事件总线，前端可通过 WebSocket 事件订阅：

| 事件流      | 内容                     |
| ----------- | ------------------------ |
| `lifecycle` | agent 运行开始/结束/错误 |
| `tool`      | 工具调用前/后            |
| `assistant` | LLM 输出（文本/推理）    |
| `error`     | 错误事件                 |

### 2.4 Subagent 系统

OpenClaw 有完整的子代理编排能力：

```
父 Agent
  │
  ├── sessions_spawn (生成子代理)
  │     ├── run 模式: 一次性运行，完成后公告
  │     └── session 模式: 持久会话，支持后续交互
  │
  ├── subagents list (列出子代理)
  ├── subagents steer (向子代理注入消息)
  └── subagents kill (终止子代理)

  子代理完成
  │
  ├── auto: 自动选择投递方式
  ├── parent: 通过父代理会话路由
  └── direct: 直接投递到通道
```

生命周期事件：`subagent_spawning` → `subagent_spawned` → `subagent_ended`

### 2.5 Cron / 定时任务系统

OpenClaw 有完整的 cron 实现：

```typescript
// 三种调度类型
type CronSchedule =
  | { kind: "at"; at: string } // 一次性
  | { kind: "every"; everyMs: number } // 周期性
  | { kind: "cron"; expr: string; tz?: string }; // Cron 表达式

// 两种执行模式
type CronPayload =
  | { kind: "systemEvent"; text: string } // 注入系统事件
  | { kind: "agentTurn"; message: string }; // 运行 agent

// 网关方法
cron.list / cron.add / cron.update / cron.remove / cron.run / cron.status;
```

### 2.6 产物 / 文件系统

| 组件             | 路径/端点                           | 用途                        |
| ---------------- | ----------------------------------- | --------------------------- |
| Media Server     | `GET /media/:id`                    | 临时媒体文件服务 (TTL 过期) |
| Artifact Jobs    | `{stateDir}/artifacts/jobs/`        | inbox/outbox 文件交换模型   |
| File Tools       | `read`/`write`/`edit`/`apply_patch` | Agent 文件操作工具          |
| Exec Tool        | `exec`/`process`                    | 代码执行工具                |
| HTTP Tool Invoke | `POST /api/tools/invoke`            | HTTP 调用 agent 工具        |
| Artifact Import  | `{workspace}/artifacts/imports/`    | 导入到工作空间的文件        |

---

## 3. 参考项目对比分析

### 3.1 总览对比

| 维度         | OpenWork        | AIonUI               | DeerFlow            | OpenClaw (现有 UI)  |
| ------------ | --------------- | -------------------- | ------------------- | ------------------- |
| **技术栈**   | Tauri + SolidJS | Electron + UnoCSS    | Next.js + React 19  | Lit 3 + Vite 7      |
| **通信协议** | REST + SSE      | IPC + HTTP API       | LangGraph SDK (SSE) | WebSocket (JSON 帧) |
| **后端引擎** | OpenCode CLI    | 多 CLI (含 OpenClaw) | LangGraph           | OpenClaw            |
| **多 Chat**  | ✅ 会话列表     | ✅                   | ✅ 无限滚动         | ✅                  |
| **文件操作** | ✅ 文件夹选择器 | ✅ 本地文件          | ✅ 产物面板         | ✅                  |
| **代码执行** | ✅ 时间线展示   | ✅                   | ✅ CodeMirror       | ❌ 仅文本           |
| **Subagent** | ❌              | ❌                   | ✅ SubtaskCard      | ✅ 基础             |
| **定时任务** | ❌              | ✅ (cron.json)       | ❌                  | ✅ 完整             |
| **产物下载** | ✅ Debug 导出   | ✅                   | ✅ 多格式预览       | ✅                  |
| **MCP 支持** | ✅              | ✅                   | ✅                  | ✅ (插件)           |

### 3.2 各项目关键启示

#### OpenWork → 桌面应用 + 本地编排

- **Tauri + SolidJS** 桌面方案，通过本地编排 OpenCode CLI 实现后端能力
- **SSE `/event`** 端点进行实时流式更新
- **权限系统** (allow once / always / deny) 值得借鉴
- **执行计划时间线** 展示模式
- **不适合直接参考**: 我们需要 Web UI 而非桌面应用，且后端是 OpenClaw 而非 OpenCode

#### AIonUI → 多引擎统一界面

- **Electron** 桌面应用，支持 20+ CLI 工具（**包括 OpenClaw**）
- **SQLite** 配置持久化
- **WebUI 模式** (HTTP API, 端口 25808)
- **cron.json** 模块表明已有定时任务 UI
- **关键启示**: AIonUI 已经支持 OpenClaw 作为后端引擎，说明 OpenClaw 的接口能力足以支撑完整 UI

#### DeerFlow → 前端交互模式参考

- **Next.js + React 19 + Tailwind CSS v4 + Radix UI** — 与 agent-frontend 技术栈高度一致
- **LangGraph SDK** 通信 — 需替换为 OpenClaw 的 WebSocket 协议
- **消息分组系统** (6 种语义类型) — 可直接借鉴
- **SubtaskCard** 子代理展示 — 步骤时间线 + 思维链
- **产物面板** — 代码/预览/下载三态切换
- **可调整面板布局** — `react-resizable-panels`
- **ai-elements 组件库** — 后端无关，可直接复用
- **高度可复用**: 消息分组、Subtask 展示、产物系统、组件库

#### OpenClaw 现有 UI → 协议参考

- **Lit 3 + Vite 7** 的 Control UI，通过 `GatewayBrowserClient` 连接
- **WebSocket 握手流程** — Ed25519 设备签名认证
- **事件处理** — `chat`/`presence`/`cron`/`exec.approval` 等事件
- **关键启示**: 现有 UI 的 `GatewayBrowserClient` 实现可以作为前端 WebSocket 客户端的参考

### 3.3 结论：DeerFlow 是最佳前端参考

DeerFlow 的前端与 agent-frontend 技术栈高度一致（React + Vite + Tailwind + Radix），其交互模式（多 chat、Subtask 展示、产物面板）最接近目标需求。核心差异仅在通信层：

| 层         | DeerFlow                      | 目标方案                             |
| ---------- | ----------------------------- | ------------------------------------ |
| API 客户端 | LangGraph SDK                 | OpenClaw WebSocket Client            |
| 流式 Hook  | `useStream` (LangGraph)       | `useOpenClawStream` (WebSocket 事件) |
| 会话管理   | `client.threads.*`            | `gateway.req: sessions.*`            |
| 消息格式   | LangChain Message             | OpenClaw Chat Event                  |
| 产物 URL   | `/api/threads/{id}/artifacts` | `/media/:id` + artifact jobs         |

---

## 4. 前端框架选型

### 4.1 现有基础：agent-frontend

agent-frontend 已是一个成熟的 React 19 项目：

```
技术栈: React 19 + Vite 7 + React Router 7 + React Query v5 + Zustand
       + Tailwind CSS v4 + Radix UI (shadcn/ui) + Axios + Biome

已有模块: 16 个功能模块 (dashboard, auth, groups, qa, analytics 等)
已有页面: 13 个路由页面
Git 状态: 活跃开发中 (feat/workspace-private-group-multimodal 分支)
```

### 4.2 选型决策

**决策: 在 agent-frontend 现有技术栈上扩展，不推翻重建**

理由：

1. **技术栈一致**: agent-frontend 的 React 19 + Vite 7 + Tailwind + Radix 与 DeerFlow 前端高度一致，可以直接借鉴 DeerFlow 的组件和交互模式
2. **已有基础**: 16 个业务模块和 13 个路由页面不应被丢弃
3. **团队熟悉**: 团队已在此代码库上活跃开发
4. **增量扩展**: 新增 OpenClaw 对接功能作为新模块，不影响现有业务

### 4.3 需要新增的依赖

```json
{
  "dependencies": {
    // WebSocket 通信
    "@noble/ed25519": "^2.x", // 设备签名认证

    // UI 组件 (参考 DeerFlow ai-elements)
    "react-resizable-panels": "^2.x", // 可调整面板布局
    "streamdown": "^1.x", // 流式 Markdown 渲染
    "shiki": "^3.x", // 代码语法高亮
    "@uiw/react-codemirror": "^4.x" // 代码编辑器

    // 状态管理增强 (已有 React Query + Zustand)
    // 无需额外依赖
  }
}
```

### 4.4 前端架构设计

```
agent-frontend/
├── src/
│   ├── features/                    # 现有业务模块
│   │   ├── dashboard/
│   │   ├── auth/
│   │   └── ... (16 个现有模块)
│   │
│   ├── features/openclaw/           # 新增: OpenClaw 对接模块
│   │   ├── api/
│   │   │   ├── gateway-client.ts    # WebSocket 网关客户端
│   │   │   ├── device-auth.ts       # Ed25519 设备认证
│   │   │   └── types.ts             # OpenClaw 协议类型
│   │   │
│   │   ├── hooks/
│   │   │   ├── use-gateway.ts       # 网关连接 hook
│   │   │   ├── use-chat-stream.ts   # 聊天流式 hook
│   │   │   ├── use-sessions.ts      # 会话管理 hook
│   │   │   ├── use-cron.ts          # 定时任务 hook
│   │   │   └── use-subagents.ts     # 子代理 hook
│   │   │
│   │   ├── components/
│   │   │   ├── chat/                # 聊天组件
│   │   │   │   ├── chat-list.tsx    # 会话列表 (侧边栏)
│   │   │   │   ├── message-list.tsx # 消息列表 (分组渲染)
│   │   │   │   ├── message-item.tsx # 单条消息
│   │   │   │   ├── input-box.tsx    # 输入框
│   │   │   │   └── streaming-indicator.tsx
│   │   │   │
│   │   │   ├── subagent/            # 子代理展示
│   │   │   │   ├── subtask-card.tsx # 子任务卡片
│   │   │   │   └── step-timeline.tsx# 步骤时间线
│   │   │   │
│   │   │   ├── artifacts/           # 产物面板
│   │   │   │   ├── artifact-panel.tsx
│   │   │   │   ├── artifact-detail.tsx
│   │   │   │   └── artifact-download.tsx
│   │   │   │
│   │   │   ├── cron/                # 定时任务
│   │   │   │   ├── cron-list.tsx
│   │   │   │   ├── cron-editor.tsx
│   │   │   │   └── cron-history.tsx
│   │   │   │
│   │   │   └── tool-call/           # 工具调用展示
│   │   │       ├── tool-call-card.tsx
│   │   │       └── exec-approval.tsx
│   │   │
│   │   ├── stores/
│   │   │   ├── gateway-store.ts     # 网关连接状态
│   │   │   ├── chat-store.ts        # 聊天状态
│   │   │   └── session-store.ts     # 会话状态
│   │   │
│   │   └── pages/
│   │       ├── chat-page.tsx        # 主聊天页
│   │       ├── cron-page.tsx        # 定时任务页
│   │       └── settings-page.tsx    # 设置页
│   │
│   └── ... (现有代码)
```

---

## 5. 对接协议方案

### 5.1 方案对比

| 方案                     | 通信方式   | 功能覆盖 | 实现复杂度 | 推荐度     |
| ------------------------ | ---------- | -------- | ---------- | ---------- |
| A. 纯 WebSocket 网关     | WS JSON 帧 | 100%     | 中         | ⭐⭐⭐⭐⭐ |
| B. OpenAI 兼容 API       | HTTP + SSE | ~30%     | 低         | ⭐⭐       |
| C. Open Responses API    | HTTP + SSE | ~60%     | 中         | ⭐⭐⭐     |
| D. WebSocket + HTTP 混合 | WS + HTTP  | 100%     | 中高       | ⭐⭐⭐⭐   |

### 5.2 推荐方案：A — 纯 WebSocket 网关协议

**理由**：

1. **功能完整**: WebSocket 网关是 OpenClaw 的原生协议，覆盖 chat、sessions、cron、config、agent、devices、execApprovals 等全部方法
2. **双向通信**: 支持服务端推送事件（chat streaming、cron 事件、exec approval 请求），无需额外 SSE 连接
3. **已有参考**: OpenClaw 现有 UI (`ui/src/ui/gateway.ts`) 已有完整的 `GatewayBrowserClient` 实现
4. **单一连接**: 一个 WebSocket 连接承载所有通信，比混合方案简单

**唯一需要处理的复杂点**: Ed25519 设备认证。但这在浏览器中可通过 `crypto.subtle` 实现（现有 UI 已验证可行）。

### 5.3 协议适配层设计

前端需要实现一个协议适配层，将 OpenClaw 的 WebSocket 帧转换为 React 可消费的状态：

```typescript
// gateway-client.ts — 核心客户端

class OpenClawGatewayClient {
  private ws: WebSocket;
  private pendingRequests = new Map<string, { resolve; reject }>();
  private eventHandlers = new Map<string, Set<(data) => void>>();

  // 连接与认证
  async connect(url: string): Promise<HelloOk> {
    // 1. 建立 WebSocket
    // 2. 接收 connect.challenge
    // 3. Ed25519 签名
    // 4. 发送 connect 请求
    // 5. 接收 hello-ok
  }

  // 请求-响应模式
  request<T>(method: string, params?: unknown): Promise<T> {
    const id = crypto.randomUUID();
    this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });
  }

  // 事件订阅
  on(event: string, handler: (data) => void): () => void {
    // 订阅事件，返回取消订阅函数
  }

  // 核心方法封装
  chat = {
    send: (params) => this.request("chat.send", params),
    history: (params) => this.request("chat.history", params),
    abort: (runId) => this.request("chat.abort", { runId }),
  };

  sessions = {
    list: () => this.request("sessions.list"),
    patch: (key, patch) => this.request("sessions.patch", { key, patch }),
    delete: (key) => this.request("sessions.delete", { key }),
  };

  cron = {
    list: () => this.request("cron.list"),
    add: (job) => this.request("cron.add", { job }),
    update: (id, patch) => this.request("cron.update", { id, patch }),
    remove: (id) => this.request("cron.remove", { id }),
    run: (id) => this.request("cron.run", { id }),
  };
}
```

```typescript
// use-chat-stream.ts — 核心 React Hook

function useChatStream(sessionKey: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const client = useGatewayClient();

  // 订阅 chat 事件
  useEffect(() => {
    const unsubscribe = client.on("chat", (data) => {
      if (data.sessionKey !== sessionKey) return;

      if (data.state === "streaming") {
        // 增量更新消息
        setMessages((prev) => mergeIncrementalMessage(prev, data));
      } else if (data.state === "final") {
        setIsStreaming(false);
        setMessages((prev) => finalizeMessage(prev, data));
      } else if (data.state === "error") {
        setIsStreaming(false);
      }
    });
    return unsubscribe;
  }, [client, sessionKey]);

  // 发送消息
  const sendMessage = useCallback(
    async (text: string, attachments?: File[]) => {
      setIsStreaming(true);
      await client.chat.send({
        sessionKey,
        message: text,
        attachments: attachments?.map((a) => a.name),
        thinking: "auto",
      });
    },
    [client, sessionKey],
  );

  return { messages, isStreaming, sendMessage, abort: () => client.chat.abort() };
}
```

### 5.4 是否需要自研协议？

**结论: 不需要自研通信协议，复用 OpenClaw 已有的 WebSocket 网关协议即可。**

OpenClaw 的网关协议已经是一个完整的、经过验证的通信协议，包含：

- 认证（Ed25519 设备签名）
- 请求-响应模式（req/res 帧）
- 服务器推送（event 帧）
- 序列号与间隙检测
- 自动重连
- 心跳/presence

前端只需实现一个 WebSocket 客户端来消费这个协议，无需发明新协议。

### 5.5 认证流程

OpenClaw 网关支持多种认证模式：

| 模式            | 配置         | 适合场景 |
| --------------- | ------------ | -------- |
| `none`          | 无认证       | 本地开发 |
| `token`         | 共享 token   | 简单部署 |
| `password`      | 用户名密码   | 个人使用 |
| `trusted-proxy` | 反向代理认证 | 生产部署 |

对于 Web UI 场景，推荐：

- **开发阶段**: `none` 或 `token` 模式，简化调试
- **生产阶段**: `trusted-proxy` 模式，通过 Nginx/Caddy 反向代理处理认证

设备认证（Ed25519）是网关协议的一部分，即使认证模式为 `none` 也需要完成握手流程。前端使用 `crypto.subtle` 生成和签名设备密钥对（需要安全上下文 HTTPS 或 localhost）。

---

## 6. 产物上传下载方案

### 6.1 OpenClaw 现有的文件处理能力

```
┌─────────────────────────────────────────────────────────┐
│                   OpenClaw 文件系统                       │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ Media Server│  │ Artifact Jobs│  │  File Tools    │ │
│  │ /media/:id  │  │ inbox/outbox │  │ read/write/exec│ │
│  │ (TTL 临时)  │  │ (作业交换)   │  │ (Agent 操作)   │ │
│  └──────┬──────┘  └──────┬───────┘  └───────┬────────┘ │
│         │                │                  │          │
│         └────────────────┼──────────────────┘          │
│                          ▼                              │
│              ┌───────────────────────┐                  │
│              │  HTTP Tool Invoke     │                  │
│              │  POST /api/tools/invoke│                 │
│              └───────────────────────┘                  │
└─────────────────────────────────────────────────────────┘
```

### 6.2 上传方案

**方案: 利用 OpenClaw 的 media server + chat.send 附件机制**

OpenClaw 的 `chat.send` 方法支持 `attachments` 参数。前端上传流程：

```
1. 前端选择文件
2. POST /api/tools/invoke (tool: "artifact_jobs", action: "create") → 获取 jobId
3. POST /api/tools/invoke (tool: "artifact_jobs", action: "attach_file") → 上传到 inbox
4. WebSocket req: chat.send (message + 引用附件)
5. Agent 处理附件，生成产物到 outbox
6. Agent 通过 artifact_jobs finalize 导出到工作空间
7. 前端通过 /media/:id 或 artifact_jobs list_files 获取产物
```

**简化方案（推荐初期实现）**:

对于纯文本/图片附件，可直接通过 `chat.send` 的 `attachments` 字段传递文件路径或 base64 内容，由 OpenClaw 的 media understanding 自动处理。

### 6.3 下载方案

**产物下载的三种路径**:

| 产物类型           | 获取方式         | URL 模式                                                                                                 |
| ------------------ | ---------------- | -------------------------------------------------------------------------------------------------------- |
| 临时媒体文件       | Media Server     | `GET /media/:id` (TTL 过期)                                                                              |
| Artifact Jobs 产物 | HTTP Tool Invoke | `POST /api/tools/invoke { tool: "artifact_jobs", action: "list_files", args: { jobId, box: "outbox" } }` |
| 工作空间文件       | Agent read 工具  | `POST /api/tools/invoke { tool: "read", args: { path } }`                                                |

**前端产物面板设计（参考 DeerFlow）**:

```
┌─────────────────────────────────────────────┐
│  产物面板                                    │
│  ┌─────────────────────────────────────────┐│
│  │ 文件选择器: [report.md ▼]  [代码] [预览] ││
│  ├─────────────────────────────────────────┤│
│  │                                         ││
│  │  # Report                               ││
│  │  ## Summary                             ││
│  │  ...                                    ││
│  │                                         ││
│  ├─────────────────────────────────────────┤│
│  │ [新窗口打开] [复制] [下载] [关闭]        ││
│  └─────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

- **代码视图**: CodeMirror 只读渲染（支持语法高亮）
- **Markdown 预览**: 流式 Markdown 渲染
- **HTML 预览**: iframe sandbox
- **图片预览**: 直接显示
- **不可预览**: 下载按钮

### 6.4 文件安全边界

OpenClaw 已有完善的文件安全策略：

- `inbound-path-policy.ts`: 控制哪些文件路径可被读取
- `local-roots.ts`: 限制媒体文件根目录
- `assertSourceAllowed()`: artifact jobs 源文件检查
- `assertSafeFileName()`: 防止路径遍历

前端无需额外实现安全控制，只需遵守 OpenClaw 的路径约束。

---

## 7. Agent / Subagent 交互展示方案

### 7.1 消息分组系统（参考 DeerFlow）

将 OpenClaw 的流式事件分组为语义化的 UI 组件：

```typescript
type MessageGroup =
  | { type: "human"; message: ChatMessage }
  | { type: "assistant"; message: ChatMessage }
  | { type: "assistant:processing"; reasoning?: string; toolCalls: ToolCall[] }
  | { type: "assistant:subagent"; subtask: SubtaskInfo }
  | { type: "assistant:artifact"; artifacts: string[] }
  | { type: "system"; message: string };
```

**分组规则**:

- 有最终文本内容 → `assistant` 独立气泡
- 有推理/工具调用但无最终内容 → `assistant:processing` 折叠组
- 调用 `sessions_spawn` 工具 → `assistant:subagent` 子任务卡片
- 调用 `artifact_jobs` 工具 → `assistant:artifact` 产物展示
- 系统消息 → `system` 低优先级显示

### 7.2 Subagent 展示方案

**参考 DeerFlow 的 SubtaskCard，适配 OpenClaw 的 subagent 生命周期**:

```
┌─────────────────────────────────────────────────────┐
│  🔧 子任务: "研究 React 19 新特性"              ▼  │
│  ┌───────────────────────────────────────────────┐ │
│  │ 状态: 🟢 运行中 | 耗时: 2m30s | 模型: gpt-4o │ │
│  ├───────────────────────────────────────────────┤ │
│  │ 📝 任务描述:                                  │ │
│  │ 请研究 React 19 的新特性并总结...             │ │
│  ├───────────────────────────────────────────────┤ │
│  │ 步骤时间线:                                   │ │
│  │ ✨ [1] AI 推理: 让我先搜索 React 19...       │ │
│  │ 🔧 [2] 工具调用: web_search("React 19 ...")  │ │
│  │ ✨ [3] AI 推理: 找到了相关信息...             │ │
│  │ 🔧 [4] 工具调用: web_fetch("https://...")    │ │
│  │ ✨ [5] AI 推理: 正在整理结果...               │ │
│  ├───────────────────────────────────────────────┤ │
│  │ ✅ 完成:                                      │ │
│  │ React 19 的主要新特性包括:                    │ │
│  │ 1. Actions API...                             │ │
│  │ 2. use() Hook...                              │ │
│  │                                               │ │
│  │ Stats: runtime 3m15s • tokens 8.2k (in/out) │ │
│  └───────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

**数据来源**:

- OpenClaw 的 `subagents list` 工具返回 `SubagentRunRecord`（含 runId、task、label、status、startedAt）
- OpenClaw 的 agent 事件流 (`lifecycle`/`tool`/`assistant` streams) 提供步骤详情
- 前端通过 WebSocket 事件实时更新步骤

**步骤获取方式**:

1. **实时**: 订阅子代理会话的 `chat` 事件（通过 `sessionKey` 过滤）
2. **历史**: 通过 `sessions_history` 获取子代理会话历史

### 7.3 工具调用展示

```
┌─────────────────────────────────────────┐
│  🔧 web_search                    ▼    │
│  ┌─────────────────────────────────────┐│
│  │ 参数:                                ││
│  │ { "query": "React 19 new features" }││
│  ├─────────────────────────────────────┤│
│  │ 结果:                                ││
│  │ 找到 10 条结果...                    ││
│  └─────────────────────────────────────┘│
└─────────────────────────────────────────┘
```

- 默认折叠，点击展开
- 显示工具名、参数、结果
- `exec` 工具特殊处理：显示为终端样式
- `before_tool_call` 可触发审批 UI

### 7.4 执行审批 UI

OpenClaw 支持 `execApprovals` 网关方法。当 agent 需要执行危险操作时：

```
┌─────────────────────────────────────────────────────┐
│  ⚠️ 执行审批请求                                     │
│                                                     │
│  Agent 想要执行:                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │ $ npm install --save react@19                 │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  工作目录: /Users/jiaoguo/project                    │
│                                                     │
│  [允许一次] [始终允许] [拒绝]                        │
└─────────────────────────────────────────────────────┘
```

前端通过 WebSocket 订阅 `exec.approval.request` 事件，弹出审批对话框。

---

## 8. 会话管理方案

### 8.1 OpenClaw 会话模型

```
Session Key 结构:
  agent:{agentId}:{mainKey}

示例:
  agent:main:main           — 主 agent 的主会话
  agent:main:webchat:user1  — 主 agent 的 webchat 用户会话
  agent:researcher:subagent:{uuid} — 研究员子代理的临时会话
```

### 8.2 多 Chat 实现

**前端会话列表（侧边栏）**:

```
┌──────────────────────────┐
│ + 新建对话               │
│ ─────────────────────    │
│ 🔍 搜索...               │
│ ─────────────────────    │
│ 📌 当前对话              │
│    React 19 调研          │
│ ─────────────────────    │
│ 今天                      │
│    代码重构讨论            │
│    定时任务设计            │
│ ─────────────────────    │
│ 昨天                      │
│    Bug 修复               │
│    API 文档编写            │
│ ─────────────────────    │
│ 更早                      │
│    项目初始化              │
└──────────────────────────┘
```

**实现方式**:

1. 通过 `sessions.list` 网关方法获取会话列表
2. 每个会话项显示：标题（从首条消息提取或自定义）、最后活动时间、消息预览
3. 支持搜索、重命名（`sessions.patch`）、删除（`sessions.delete`）
4. 新建对话：生成新的 sessionKey 或使用 `agent:main:webchat:{userId}:{uuid}`

**会话切换**:

- 点击侧边栏会话项 → 更新当前 sessionKey → 加载 `chat.history` → 渲染消息

**多 Agent 支持**:

- OpenClaw 支持多 agent（`agents.list`），前端可在侧边栏顶部添加 agent 选择器
- 每个 agent 有独立的会话空间

### 8.3 会话状态持久化

OpenClaw 已有完整的会话持久化：

- 会话历史存储在本地磁盘
- 重启后自动恢复
- 支持上下文压缩（`before_compaction` / `after_compaction` hooks）

前端无需管理会话持久化，只需从后端加载和展示。

---

## 9. 定时任务管理方案

### 9.1 前端 Cron 管理 UI

OpenClaw 已有完整的 cron 后端，前端只需提供管理界面：

```
┌─────────────────────────────────────────────────────────────┐
│  定时任务                              [+ 新建任务]          │
├─────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────┐ │
│  │ 📋 每日代码审查                      [启用] [编辑] [删除]│ │
│  │    📅 每天 09:00  |  🤖 agent:main                    │ │
│  │    📝 agentTurn: "审查昨天的代码提交..."                │ │
│  │    📊 上次运行: 2026-07-06 09:00 ✅ (2m30s)           │ │
│  │    📊 下次运行: 2026-07-07 09:00                      │ │
│  └───────────────────────────────────────────────────────┘ │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ 📋 每周报告生成                      [启用] [编辑] [删除]│ │
│  │    📅 每周一 10:00  |  🤖 agent:reporter              │ │
│  │    📝 agentTurn: "生成本周工作总结..."                  │ │
│  │    📊 上次运行: 2026-07-01 10:00 ✅ (5m12s)           │ │
│  │    📊 下次运行: 2026-07-08 10:00                      │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**新建任务编辑器**:

```
┌─────────────────────────────────────────────────────┐
│  新建定时任务                                    ✕  │
├─────────────────────────────────────────────────────┤
│  名称: [每日代码审查                          ]     │
│                                                     │
│  调度类型:                                          │
│    ( ) 一次性   ( ) 周期性   (●) Cron 表达式        │
│                                                     │
│  Cron 表达式: [0 9 * * *                      ]     │
│  时区: [Asia/Shanghai ▼]                            │
│  下次运行: 2026-07-07 09:00                         │
│                                                     │
│  Agent: [main ▼]                                    │
│  会话目标: (●) 主会话  ( ) 隔离会话                  │
│                                                     │
│  执行类型:                                          │
│    ( ) 系统事件注入                                  │
│    (●) Agent 运行                                   │
│                                                     │
│  消息内容:                                          │
│  ┌─────────────────────────────────────────────┐    │
│  │ 审查昨天的代码提交，总结变更内容...           │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  投递方式:                                          │
│    (●) 无   ( ) 公告   ( ) Webhook                  │
│                                                     │
│  [取消]                              [创建任务]      │
└─────────────────────────────────────────────────────┘
```

### 9.2 实现方式

```typescript
// use-cron.ts — 定时任务 Hook

function useCronJobs() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const client = useGatewayClient();

  // 加载任务列表
  const refresh = useCallback(async () => {
    const result = await client.cron.list();
    setJobs(result.jobs);
  }, [client]);

  // 创建任务
  const createJob = useCallback(
    async (job: Omit<CronJob, "id" | "state">) => {
      await client.cron.add({ job });
      await refresh();
    },
    [client, refresh],
  );

  // 更新任务
  const updateJob = useCallback(
    async (id: string, patch: Partial<CronJob>) => {
      await client.cron.update({ id, patch });
      await refresh();
    },
    [client, refresh],
  );

  // 删除任务
  const removeJob = useCallback(
    async (id: string) => {
      await client.cron.remove({ id });
      await refresh();
    },
    [client, refresh],
  );

  // 立即运行
  const runJob = useCallback(
    async (id: string) => {
      await client.cron.run({ id });
    },
    [client],
  );

  // 订阅 cron 事件 (运行状态更新)
  useEffect(() => {
    const unsubscribe = client.on("cron", (data) => {
      // 更新任务运行状态
      setJobs((prev) => updateJobStatus(prev, data));
    });
    return unsubscribe;
  }, [client]);

  return { jobs, refresh, createJob, updateJob, removeJob, runJob };
}
```

### 9.3 定时任务运行历史

通过 `cron.runs` 方法获取每个任务的运行历史，展示为时间线：

```
运行历史 — 每日代码审查
┌──────────────────────────────────────────────┐
│ 2026-07-06 09:00  ✅ 成功  2m30s  [查看结果] │
│ 2026-07-05 09:00  ✅ 成功  3m15s  [查看结果] │
│ 2026-07-04 09:00  ❌ 失败  1m02s  [查看错误] │
│ 2026-07-03 09:00  ✅ 成功  2m48s  [查看结果] │
└──────────────────────────────────────────────┘
```

---

## 10. 可行性评估与实施路线

### 10.1 可行性评估

| 维度              | 评估        | 说明                                                    |
| ----------------- | ----------- | ------------------------------------------------------- |
| **协议对接**      | ✅ 完全可行 | OpenClaw 已有完整的 WebSocket 网关协议，无需自研        |
| **多 Chat**       | ✅ 完全可行 | OpenClaw 已有 sessions 管理和 chat.history              |
| **文件操作**      | ✅ 可行     | OpenClaw 有 media server + artifact jobs + file tools   |
| **代码执行**      | ✅ 可行     | OpenClaw 有 exec 工具 + execApprovals 审批              |
| **Subagent 展示** | ✅ 可行     | OpenClaw 有完整 subagent 系统 + 事件流                  |
| **定时任务**      | ✅ 完全可行 | OpenClaw 有完整 cron 系统 + 网关方法                    |
| **前端技术栈**    | ✅ 无需更换 | agent-frontend 已有 React 19 + Vite + Radix UI          |
| **认证**          | ⚠️ 需注意   | 需要 HTTPS 或 localhost（crypto.subtle 要求安全上下文） |

### 10.2 风险与缓解

| 风险                             | 级别 | 缓解措施                                  |
| -------------------------------- | ---- | ----------------------------------------- |
| WebSocket 协议版本变更           | 低   | OpenClaw 有 `PROTOCOL_VERSION` 协商机制   |
| Ed25519 认证在非安全上下文不可用 | 中   | 确保部署在 HTTPS 或 localhost 下          |
| 大文件传输性能                   | 中   | 使用 chunked upload 或 artifact_jobs 分片 |
| 子代理步骤获取复杂               | 中   | 先实现基础状态展示，再逐步完善步骤详情    |
| agent-frontend 现有模块冲突      | 低   | 新功能作为独立模块，不影响现有代码        |

### 10.3 分阶段实施路线

#### Phase 1: 基础连接与单 Chat（MVP）

**目标**: 验证 WebSocket 连接和基本对话

- [ ] 实现 `OpenClawGatewayClient`（WebSocket 连接 + Ed25519 认证）
- [ ] 实现 `useGateway` hook（连接状态管理）
- [ ] 实现 `useChatStream` hook（消息发送 + 流式接收）
- [ ] 实现基础聊天页面（消息列表 + 输入框）
- [ ] 实现工具调用展示（折叠卡片）
- [ ] 实现消息流式渲染（Markdown + 代码高亮）

#### Phase 2: 多 Chat + 会话管理

**目标**: 完整的多会话体验

- [ ] 实现会话列表侧边栏（`sessions.list` + 搜索）
- [ ] 实现新建/切换/删除会话
- [ ] 实现会话历史加载（`chat.history`）
- [ ] 实现消息分组渲染（6 种语义类型）
- [ ] 实现会话标题自动生成/自定义

#### Phase 3: 产物与文件

**目标**: 文件上传下载和产物展示

- [ ] 实现文件上传（通过 artifact_jobs 或 chat.send 附件）
- [ ] 实现产物面板（代码/预览/下载三态）
- [ ] 实现可调整面板布局（chat + artifacts）
- [ ] 实现产物列表和文件选择器
- [ ] 实现 CodeMirror 代码编辑器（只读预览）

#### Phase 4: Subagent 展示

**目标**: 子代理运行可视化

- [ ] 实现 SubtaskCard 组件
- [ ] 实现子代理步骤时间线（实时 + 历史）
- [ ] 实现子代理状态指示器（运行中/完成/失败/超时）
- [ ] 实现子代理结果展示（Markdown 渲染）
- [ ] 实现子代理 steer/kill 操作

#### Phase 5: 定时任务管理

**目标**: 完整的 cron 管理 UI

- [ ] 实现定时任务列表页面
- [ ] 实现新建/编辑任务表单
- [ ] 实现 Cron 表达式可视化编辑器
- [ ] 实现任务运行历史
- [ ] 实现任务运行状态实时更新（cron 事件订阅）
- [ ] 实现立即运行/启用/禁用操作

#### Phase 6: 高级功能

**目标**: 生产级体验

- [ ] 实现执行审批 UI（exec.approval 事件）
- [ ] 实现配置管理页面（config.get/apply）
- [ ] 实现模型选择器（models 方法）
- [ ] 实现多 Agent 切换（agents.list）
- [ ] 实现设备配对 UI（devices.pair.\*）
- [ ] 实现离线/重连状态处理

### 10.4 工作量估算

| Phase   | 核心组件数 | 复杂度 | 说明               |
| ------- | ---------- | ------ | ------------------ |
| Phase 1 | 5          | 中     | 协议适配是核心难点 |
| Phase 2 | 5          | 中     | 侧边栏和会话管理   |
| Phase 3 | 5          | 中高   | 文件系统对接       |
| Phase 4 | 5          | 高     | 子代理事件聚合     |
| Phase 5 | 6          | 中     | Cron UI 相对独立   |
| Phase 6 | 6          | 中     | 渐进增强           |

### 10.5 关键设计决策总结

| 决策点       | 选择                                     | 理由                             |
| ------------ | ---------------------------------------- | -------------------------------- |
| 前端框架     | agent-frontend 现有 React 19 栈          | 已有 16 个业务模块，不推翻重建   |
| 通信协议     | WebSocket 网关协议                       | 功能完整、双向通信、已有参考实现 |
| 是否自研协议 | 否                                       | OpenClaw 已有完整协议            |
| 会话管理     | 复用 OpenClaw sessions                   | 后端已有完整实现                 |
| 子代理展示   | 参考 DeerFlow SubtaskCard                | 适配 OpenClaw 事件流             |
| 产物处理     | OpenClaw media server + artifact jobs    | 后端已有安全边界                 |
| 定时任务     | 复用 OpenClaw cron                       | 后端已有完整系统                 |
| 前端参考     | DeerFlow (主要) + OpenWork (权限/时间线) | 技术栈一致，交互模式最接近       |

---

## 附录 A: OpenClaw 网关方法完整列表

```
connect          — 握手认证
chat.send        — 发送消息 (支持附件、thinking 模式)
chat.history     — 获取会话历史
chat.abort       — 中止运行
chat.inject      — 注入消息到运行中
sessions.list    — 列出会话
sessions.patch   — 更新会话
sessions.delete  — 删除会话
cron.list        — 列出定时任务
cron.add         — 添加定时任务
cron.update      — 更新定时任务
cron.remove      — 删除定时任务
cron.run         — 立即运行任务
cron.status      — 调度器状态
config.get       — 读取配置
config.schema    — 配置 schema
config.apply     — 替换配置
config.patch     — 补丁更新配置
config.set       — 设置单个路径
agent            — 启动 agent 运行
agents.list      — 列出 agents
models           — 可用模型列表
health           — 健康检查
system           — 系统信息
logs             — 日志
channels         — 渠道列表
devices.list     — 设备列表
devices.pair.*   — 设备配对
execApprovals.*  — 执行审批
browser.*        — 浏览器控制
node.*           — 节点管理
push.*           — 推送通知
send.*           — 跨渠道发送
usage.*          — 使用量
wizard.*         — 向导
talk.*           — 语音对话
tts.*            — 文本转语音
skills.*         — 技能管理
update.*         — 更新检查
```

## 附录 B: OpenClaw 事件类型

```
chat             — 聊天流式事件 (runId, sessionKey, seq, state, message)
presence         — 在线状态
agent            — Agent 生命周期事件
cron             — 定时任务事件 (started, finished, removed)
exec.approval.*  — 执行审批请求
device.pair.*    — 设备配对事件
update.available — 更新可用
```

## 附录 C: 参考项目信息

| 项目           | 地址                                     | 技术栈             | 关键参考价值                                        |
| -------------- | ---------------------------------------- | ------------------ | --------------------------------------------------- |
| OpenWork       | github.com/different-ai/openwork         | Tauri + SolidJS    | 权限系统、执行计划时间线                            |
| AIonUI         | github.com/iOfficeAI/AionUi              | Electron + UnoCSS  | 多引擎支持(含OpenClaw)、cron UI                     |
| DeerFlow       | /Users/jiaoguo/github/deer-flow/frontend | Next.js + React 19 | 消息分组、SubtaskCard、产物面板、ai-elements 组件库 |
| OpenClaw UI    | ui/ (内置)                               | Lit 3 + Vite 7     | GatewayBrowserClient、WebSocket 协议实现            |
| agent-frontend | /Users/jiaoguo/github/agent-frontend     | React 19 + Vite 7  | 现有项目基础                                        |
