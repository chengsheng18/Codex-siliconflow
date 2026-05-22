# Codex × SiliconFlow 协议转换代理

让 OpenAI **Codex CLI** 通过 **硅基流动 (SiliconFlow)** 的模型运行，无需官方 API 订阅。

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![SiliconFlow](https://img.shields.io/badge/Upstream-SiliconFlow-orange.svg)](https://cloud.siliconflow.cn)

---

## 问题背景

OpenAI **Codex CLI** 使用 **Responses API** (`/v1/responses`)，但硅基流动仅支持 **Chat Completions API** (`/v1/chat/completions`)，两者协议不兼容，无法直接对接。

本代理在本地起一个协议转换器，完整 bridging 这两个 API 格式，让 Codex CLI 可以无缝使用硅基流动的模型。

---

## 功能特性

| 功能 | 说明 |
|------|------|
| **协议转换** | Responses API ↔ Chat Completions API 双向字段映射 |
| **多模型池** | 内置 7 个优选模型，自动按优先级选择 |
| **自动故障切换** | 模型失败时自动切换到下一个，最多遍历整个池 |
| **Web 管理面板** | 浏览器查看模型状态、实时日志、请求历史，`http://127.0.0.1:8788/` |
| **模型手动切换** | 管理面板中一键切换指定模型，或切回自动模式 |
| **启动连通测试** | 启动时逐个检测模型可用性，输出结果表格 |
| **健康追踪** | 记录每个模型的成功/失败次数、冷却时间（30s） |
| **流式/非流式** | 两种模式均支持 |
| **SSE 格式完整** | 严格遵循 OpenAI Responses API SSE 规范（10 阶段生命周期） |
| **零依赖** | 仅需 Node.js 内置模块，无需 `npm install` |

---

## 快速开始

### 1. 前置要求

- **Node.js ≥ 18**（推荐 20+）— [下载](https://nodejs.org)
- **硅基流动账号 + API Key** — [注册](https://cloud.siliconflow.cn)

### 2. 下载项目

```bash
git clone https://github.com/chengsheng18/Codex-siliconflow.git
cd Codex-siliconflow
```

### 3. 配置 API Key

**方式 1（推荐）：** 设置环境变量

```bash
# Windows PowerShell
$env:SILICONFLOW_API_KEY="sk-your-key-here"

# Windows CMD
set SILICONFLOW_API_KEY=sk-your-key-here

# macOS/Linux
export SILICONFLOW_API_KEY=sk-your-key-here
```

**方式 2：** 直接编辑 `nim-proxy.js`，修改第 44 行：

```javascript
apiKey: process.env.SILICONFLOW_API_KEY || 'sk-your-key-here',
```

### 4. 配置 Codex CLI

将 `config.toml.example` 复制到 Codex 配置目录，重命名为 `config.toml`：

```bash
# 复制示例配置
copy config.toml.example %USERPROFILE%\.codex\config.toml
```

或者手动编辑 `~/.codex/config.toml`：

```toml
[model_providers.siliconflow]
name = "siliconflow"
base_url = "http://127.0.0.1:8787/v1"
api_key = "codex-sf-proxy"
model = "Qwen/Qwen2.5-7B-Instruct"
wire_api = "responses"
```

> ⚠️ **重要**：`wire_api = "responses"` 是 Codex CLI 0.133+ 的必填字段，不可省略。

### 5. 启动代理

#### Windows（一键启动）

双击运行 `start-nim-proxy.bat`，或命令行执行：

```cmd
.\start-nim-proxy.bat
```

#### 首次使用（自动安装 + 启动）

```cmd
.\setup.bat
```

`setup.bat` 会自动：
1. 检测 Node.js 是否安装
2. 检测端口 8787/8788 是否被占用，自动释放
3. 启动代理
4. 自动打开管理面板 (`http://127.0.0.1:8788/`)

#### 手动启动

```bash
node nim-proxy.js
```

### 6. 启动 Codex CLI

代理启动后（看到 `Ready! Now start Codex.`），新开一个终端启动 Codex CLI：

```bash
codex
```

---

## 管理面板

代理启动后，浏览器访问 **http://127.0.0.1:8788/**

### 功能一览

```
┌─────────────────────────────────────────────────┐
│  ⚡ Nim-Proxy 管理面板        v3.6   ● 已连接 │
│  请求: 42  |  成功率: 97%  |  模型: 6/7   │
├──────────────────┬──────────────────────────────┤
│  📦 模型池管理    │  📡 实时日志                   │
│                  │                              │
│  Qwen2.5 7B    │  [INFO] Proxy listening...  │
│  ✓ 当前使用      │  [INFO] Model Qwen... OK   │
│                  │  [WARN] Rate limited...     │
│  DeepSeek V3.2  │                              │
│  [使用此模型]    │                              │
│                  ├──────────────────────────────┤
│  DeepSeek R1     │  📋 最近请求                   │
│  [使用此模型]    │                              │
│                  │  12:03  Qwen2.5  ✓ 成功    │
│  + 添加新模型    │  12:01  R1       ✗ 失败    │
└──────────────────┴──────────────────────────────┘
```

| 区域 | 功能 |
|------|------|
| **模型池（左侧）** | 查看所有模型健康状态、启用/禁用、删除、调整优先级；点击「使用此模型」立即切换 |
| **实时日志（右上）** | SSE 推送代理运行日志，支持 INFO/WARN/ERROR 过滤，自动滚动 |
| **请求历史（右下）** | 最近 20 条请求记录，含模型、状态、Tokens 消耗 |

### 模型切换操作

1. 在模型卡片上点击 **「使用此模型」**
2. 卡片立即变绿，显示 **「✓ 当前使用」**
3. 代理后续请求将优先使用该模型
4. 点击 **「↺ 切回自动」** 恢复智能自动选择

---

## 模型池

| # | 模型 ID | 说明 | 优先级 |
|---|---------|------|--------|
| 1 | `Qwen/Qwen2.5-7B-Instruct` | 通义千问 7B，轻量高效，默认首选 | 1 |
| 2 | `deepseek-ai/DeepSeek-V3.2` | DeepSeek 最新旗舰，编程能力顶级 | 2 |
| 3 | `deepseek-ai/DeepSeek-V3` | DeepSeek 经典旗舰，稳定可靠 | 3 |
| 4 | `deepseek-ai/DeepSeek-R1` | 推理增强模型，复杂逻辑强 | 4 |
| 5 | `Qwen/Qwen3-Coder-30B-A3B-Instruct` | 阿里 MoE 架构，专攻代码 | 5 |
| 6 | `Qwen/Qwen3.5-397B-A17B` | 阿里超大规模通用模型 | 6 |
| 7 | `MiniMaxAI/MiniMax-M2.5` | MiniMax 最新模型 | 7 |

在**管理面板**中可以动态添加/删除/禁用模型，无需重启代理。

---

## 架构

```
Codex CLI (Responses API)
     │
     │  POST /v1/responses
     ▼
nim-proxy  (localhost:8787)
     │
     ├─ 协议转换: Responses → Chat Completions
     ├─ 模型选择 + 故障切换
     ├─ 健康追踪 + 冷却机制
     └─ SSE 格式转换: Chat → Responses
     │
     │  POST /v1/chat/completions
     ▼
SiliconFlow API
```

---

## 启动输出示例

```
[CONNECTIVITY TEST] Testing connection to SiliconFlow...
  Target: https://api.siliconflow.cn/v1/chat/completions
  Models to test: 7

+----------------------------------+--------+-------------------------------+
| Model                            | Status | Detail                       |
+----------------------------------+--------+-------------------------------+
| ✓ Qwen2.5 7B Instruct            |   OK   | HTTP 200                      |
| ✓ DeepSeek V3.2                  |   OK   | HTTP 200                      |
| ✗ DeepSeek R1                    | FAIL   | HTTP 400 (rate limited)       |
+----------------------------------+--------+-------------------------------+
  Result: 6/7 models available, 1 failed

+==========================================================+
|   SiliconFlow Proxy for Codex CLI  v3.6                 |
|   Responses <-> Chat Completions                          |
|   Multi-Model Pool + Auto Failover + Web Admin          |
+----------------------------------------------------------+
|   Listen : http://127.0.0.1:8787/v1                   |
|   Admin  : http://127.0.0.1:8788/                     |
|   Target : https://api.siliconflow.cn/v1                 |
|   Models : 7 in pool (1 active)                         |
+----------------------------------------------------------+
Ready! Now start Codex.
```

---

## 文件说明

| 文件 | 说明 |
|------|------|
| `nim-proxy.js` | 主代理文件（Node.js，零依赖） |
| `admin/index.html` | Web 管理面板（纯 HTML/CSS/JS，无构建步骤） |
| `config.toml.example` | Codex CLI 配置示例 |
| `start-nim-proxy.bat` | Windows 启动脚本（自动释放端口） |
| `setup.bat` | Windows 一键安装启动脚本（检测依赖 + 启动 + 打开浏览器） |
| `README.md` | 本文件 |

---

## 注意事项

1. **硅基流动账户需有余额** — 代理启动后如果看到 `HTTP 403`，通常是余额不足，需前往 [硅基流动控制台](https://cloud.siliconflow.cn) 充值。

2. **Codex CLI 版本需 ≥ 0.133.0** — 仅支持 `wire_api="responses"` 模式，不支持 `chat` 模式。

3. **代理必须保持运行** — `start-nim-proxy.bat` 的窗口不能关闭，关闭即停止代理。可以用 `setup.bat` 以最小化方式运行。

4. **管理面板仅本地访问** — 8788 端口仅绑定 `127.0.0.1`，外部无法访问，可放心使用。

5. **API Key 安全** — `nim-proxy.js` 中的 Key 仅用于本地代理转发，**不会对外暴露**。建议使用环境变量方式配置，避免 Key 进入版本控制。

6. **免费层级不支持 Function Calling** — 硅基流动 L0/免费层级不支持 `tools` 字段，代理会自动剥离该字段（日志中可见 `⚠ Dropped N tools`）。

---

## 故障排除

### `stream closed before completion`
- ✅ 已在 v3.4 中修复，确保使用最新版 `nim-proxy.js`
- 检查 SSE 事件格式是否正确（管理面板实时日志中查看）

### `ECONNRESET` / 网络错误
- 检查是否能访问 `https://api.siliconflow.cn`（国内网络通常没问题）
- 检查 API Key 是否有效

### `Model "xxx" not found`
- 通常是模型 ID 编码问题，v3.6 已修复
- 确保使用最新版 `admin/index.html`

### 管理面板无法访问
- 确认代理已启动（8788 端口监听）
- 浏览器访问 `http://127.0.0.1:8788/`（不要用 `localhost`，某些环境解析不一致）

---

## License

MIT

---

## 更新日志

| 版本 | 日期 | 核心变更 |
|------|------|----------|
| v3.6 | 2026-05-22 | 前端 UX 重构：每模型独立切换按钮；修复 encodeURIComponent Bug |
| v3.5 | 2026-05-22 | Web 管理面板（实时日志 + 请求历史 + 模型 CRUD） |
| v3.4 | 2026-05-21 | SSE 格式完全重写（10 阶段生命周期，解决 Codex 断连） |
| v3.2 | 2026-05-21 | role:developer→system 映射；Tools 字段剥离 |
| v3.1 | 2026-05-20 | 启动连通性测试 |
| v3.0 | 2026-05-20 | 切换上游至硅基流动（原 NVIDIA NIM 在国内无法连通） |
| v2.0 | 2026-05-19 | 多模型池 + 自动故障切换 |
| v1.0 | 2026-05-18 | 初始版本，基础协议转换 |
