/**
 * ============================================
 *  Codex <-> SiliconFlow 协议转换代理 v3.6
 *  Responses API <-> Chat Completions
 *  支持多模型池 + 自动故障切换 + Web 管理面板
 * ============================================
 *
 * v3.6 变更:
 *   - 前端重构：每模型独立「使用此模型」按钮，一步切换
 *   - 修复 switchToModel 中 encodeURIComponent 未解码的 Bug
 *   - v3.5: Web 管理面板（http://127.0.0.1:8788）
 *   - v3.4: 修复 SSE 格式（10 阶段生命周期 + response.completed 包装）
 *   - v3.3: 重写 SSE 事件格式（完整 9 阶段）
 *   - v3.2: role:developer→system 映射；Tools 字段剥离
 *   - v3.1: 启动连通性测试
 *   - v3.0: 切换上游至硅基流动 SiliconFlow
 *   - v2.0: 多模型池 + 自动故障切换
 *
 * 启动: node nim-proxy.js
 * 代理监听: http://127.0.0.1:8787/v1
 * 管理面板: http://127.0.0.1:8788/
 *
 * 模型池策略:
 *   - 优先使用 activeModel（手动指定）
 *   - 否则按优先级 + 健康度自动选择
 *   - 请求失败时自动切换到下一个可用模型
 */

const http = require('http');
const https = require('https');

// ========== 配置区 ==========

/**
 * 模型池 - 按推荐顺序排列（硅基流动 SiliconFlow）
 * 选择标准：
 *  1. 适合编程/代码生成任务
 *  2. 在硅基流动上稳定可用
 *  3. 覆盖不同厂商（DeepSeek/Qwen/MiniMax/Kimi/GLM）
 */
const MODEL_POOL = [
  {
    id: 'Qwen/Qwen2.5-7B-Instruct',
    name: 'Qwen2.5 7B Instruct',
    desc: '通义千问 7B, 轻量高效, 默认首选',
    priority: 1,
  },
  {
    id: 'deepseek-ai/DeepSeek-V3.2',
    name: 'DeepSeek V3.2',
    desc: 'DeepSeek 最新旗舰, 编程能力顶级',
    priority: 2,
  },
  {
    id: 'deepseek-ai/DeepSeek-V3',
    name: 'DeepSeek V3',
    desc: 'DeepSeek 经典旗舰, 稳定可靠, 通用能力强',
    priority: 3,
  },
  {
    id: 'deepseek-ai/DeepSeek-R1',
    name: 'DeepSeek R1',
    desc: '推理增强模型, 复杂逻辑与代码推导强',
    priority: 4,
  },
  {
    id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct',
    name: 'Qwen3 Coder 30B',
    desc: '阿里 MoE 架构, 专攻代码生成',
    priority: 5,
  },
  {
    id: 'Qwen/Qwen3.5-397B-A17B',
    name: 'Qwen3.5 397B',
    desc: '阿里超大规模通用模型, 综合能力强',
    priority: 6,
  },
  {
    id: 'MiniMaxAI/MiniMax-M2.5',
    name: 'MiniMax M2.5',
    desc: 'MiniMax 最新模型, 代码和推理表现好',
    priority: 7,
  },
];

const CONFIG = {
  port: 8787,
  host: '127.0.0.1',
  // 硅基流动 SiliconFlow 上游
  upstream: {
    host: 'api.siliconflow.cn',
    path: '/v1/chat/completions',
    apiKey: process.env.SILICONFLOW_API_KEY || 'sk-umfireobuyndtbdmqylrmfnotnkzznfjftrdkjzgajzepzia',
  },
  // 故障切换配置
  failover: {
    maxRetries: MODEL_POOL.length - 1,      // 最多尝试所有模型
    retryDelay: 500,                         // 重试间隔 ms
    cooldownMs: 30000,                       // 失败模型冷却时间 (30s)
  },
};

// ========== 模型状态追踪 ==========
// 追踪每个模型的健康状态
const modelHealth = new Map();

function initModelHealth() {
  for (const m of MODEL_POOL) {
    modelHealth.set(m.id, {
      ...m,
      lastError: null,
      lastErrorTime: 0,
      consecutiveFailures: 0,
      lastSuccessTime: 0,
      totalSuccesses: 0,
      totalFailures: 0,
    });
  }
}
initModelHealth();

/** 获取下一个可用模型（跳过正在冷却的）*/
function getNextModel(excludeIds = []) {
  const now = Date.now();
  // 先尝试找没在冷却中的模型，按 priority 排序
  const candidates = [];
  for (const [id, health] of modelHealth) {
    if (excludeIds.includes(id)) continue;
    const cooldownRemaining = (health.lastErrorTime + CONFIG.failover.cooldownMs) - now;
    if (cooldownRemaining <= 0 || health.totalFailures === 0) {
      candidates.push({ id, health, cooldownRemaining });
    }
  }

  if (candidates.length > 0) {
    // 优先选成功次数多且最近成功的
    candidates.sort((a, b) => {
      // 成功多的排前面
      if (a.health.totalSuccesses !== b.health.totalSuccesses) {
        return b.health.totalSuccesses - a.health.totalSuccesses;
      }
      return a.health.priority - b.health.priority;
    });
    return candidates[0].id;
  }

  // 所有模型都在冷却中，选冷却时间最短的那个
  let bestId = null;
  let shortestCooldown = Infinity;
  for (const [id, health] of modelHealth) {
    if (excludeIds.includes(id)) continue;
    const remaining = (health.lastErrorTime + CONFIG.failover.cooldownMs) - now;
    if (remaining < shortestCooldown) {
      shortestCooldown = remaining;
      bestId = id;
    }
  }
  return bestId;
}

/** 标记模型成功 */
function markModelSuccess(modelId) {
  const h = modelHealth.get(modelId);
  if (!h) return;
  h.lastSuccessTime = Date.now();
  h.consecutiveFailures = 0;
  h.lastError = null;
  h.totalSuccesses++;
}

/** 标记模型失败 */
function markModelFailure(modelId, error) {
  const h = modelHealth.get(modelId);
  if (!h) return;
  h.lastError = typeof error === 'string' ? error : error?.message || String(error);
  h.lastErrorTime = Date.now();
  h.consecutiveFailures++;
  h.totalFailures++;
}

/** 打印模型池状态 */
function printModelPoolStatus() {
  console.log('\n[MODEL POOL] Current status:');
  for (const [id, h] of modelHealth) {
    const status = h.consecutiveFailures > 0
      ? `FAIL x${h.consecutiveFailures} (${h.lastError})`
      : `OK (${h.totalSuccesses} successes)`;
    const inCooling = (h.lastErrorTime + CONFIG.failover.cooldownMs) > Date.now();
    const coolingTag = inCooling ? ' [COOLING]' : '';
    console.log(`  ${h.name.padEnd(28)} | ${status}${coolingTag}`);
  }
  console.log('');
}


// ========== 工具函数 ==========

/** 将 Responses API 的 input 数组转换为 messages 格式 */
function inputToMessages(input) {
  if (!input) return [];
  if (typeof input === 'string') return [{ role: 'user', content: input }];

  // 角色映射：OpenAI Responses API 新角色 -> 标准 Chat Completions 角色
  const ROLE_MAP = {
    'developer': 'system',
    // 'system' -> 'system' (保持不变)
    // 'user'   -> 'user'   (保持不变)
    // 'assistant' -> 'assistant' (保持不变)
    // 'tool'   -> 'tool'   (保持不变)
  };

  const messages = [];
  for (const item of input) {
    let role = item.role || 'user';
    // 将 developer 等不兼容角色映射为标准角色
    role = ROLE_MAP[role] || role;

    switch (item.type || item.role) {
      case 'message':
        if (Array.isArray(item.content)) {
          const textParts = item.content.filter(p => p.type === 'input_text' || p.type === 'text');
          messages.push({
            role: role,
            content: textParts.map(p => p.text || p.content || '').join('\n'),
          });
        } else {
          messages.push({
            role: role,
            content: typeof item.content === 'string' ? item.content : JSON.stringify(item.content),
          });
        }
        break;
      case 'function_call':
      case 'function_call_output':
        messages.push({
          role: 'tool',
          content: JSON.stringify(item),
        });
        break;
      default:
        messages.push({
          role: role,
          content: item.content || item.text || '',
        });
    }
  }
  return messages;
}

/** 将 Chat Completions 响应转换为 Responses API 格式 */
function chatToResponse(chatBody, id, usedModel) {
  const choice = chatBody.choices?.[0];
  return {
    id: id || chatBody.id || `resp_${Date.now()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: usedModel || chatBody.model || 'siliconflow-model',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: choice?.message?.content || '',
          },
        ],
      },
    ],
    usage: {
      input_tokens: chatBody.usage?.prompt_tokens || 0,
      output_tokens: chatBody.usage?.completion_tokens || 0,
      total_tokens: chatBody.usage?.total_tokens || 0,
    },
  };
}

/** 发送 JSON 响应 */
function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
  });
  res.end(JSON.stringify(data));
}

/** 解析请求体 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { resolve(null); }
    });
    req.on('error', reject);
  });
}


// ========== 上游请求封装（带故障切换） ==========

/**
 * 向上游发送 HTTPS POST 请求（非流式）
 * 支持：自动选择模型 → 失败自动切下一个模型 → 最多尝试整个池
 */
function upstreamRequest(payload, triedModels = [], depth = 0) {
  return new Promise((resolve, reject) => {
    const modelId = getNextModel(triedModels);

    if (!modelId || depth >= CONFIG.failover.maxRetries) {
      resolve({
        status: 502,
        data: {
          error: {
            message: `All models failed. Tried: ${triedModels.join(', ')}. Last error: ${triedModels.length > 0 ? modelHealth.get(triedModels[triedModels.length - 1])?.lastError : 'unknown'}`,
            type: 'all_models_failed',
            tried_models: triedModels,
          },
        },
      });
      return;
    }

    const actualPayload = { ...payload, model: modelId };
    const postData = JSON.stringify(actualPayload);

    const options = {
      hostname: CONFIG.upstream.host,
      port: 443,
      path: CONFIG.upstream.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.upstream.apiKey}`,
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 120000,
    };

    const modelName = modelHealth.get(modelId)?.name || modelId;

    if (depth === 0) {
      console.log(`[PROXY] → Primary model: ${modelName} (${modelId})`);
    } else {
      console.log(`[PROXY] → Failover #${depth}: trying ${modelName} (${modelId}) [previously tried: ${triedModels.join(', ')}]`);
    }

    const req = https.request(options, (upRes) => {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        let parsed;
        try { parsed = JSON.parse(body); } catch (e) { parsed = body; }

        if (upRes.statusCode >= 400) {
          // 请求失败，标记这个模型并尝试下一个
          const errMsg = parsed?.error?.message || `HTTP ${upRes.statusCode}`;
          console.error(`[PROXY] ✗ Model ${modelName} failed: ${errMsg}`);
          console.error(`[PROXY]   Response body: ${body.slice(0, 500)}`);
          console.error(`[PROXY]   Sent payload (keys): ${Object.keys(payload).join(', ')}`);
          if (payload.tools) console.error(`[PROXY]   tools count: ${payload.tools.length}, first tool keys: ${JSON.stringify(Object.keys(payload.tools[0] || {}))}`);
          if (payload.messages) console.error(`[PROXY]   messages count: ${payload.messages.length}, last role: ${payload.messages[payload.messages.length-1]?.role}`);
          markModelFailure(modelId, errMsg);

          // 继续尝试下一个模型
          const newTried = [...triedModels, modelId];
          setTimeout(() => {
            upstreamRequest(payload, newTried, depth + 1).then(resolve);
          }, CONFIG.failover.retryDelay);
          return;
        }

        // 成功！
        console.log(`[PROXY] ✓ Model ${modelName} succeeded!`);
        markModelSuccess(modelId);
        resolve({ status: upRes.statusCode, data: parsed, usedModel: modelId });
      });
    });

    req.on('error', (err) => {
      // 网络级错误（ECONNRESET, ECONNREFUSED 等）
      console.error(`[PROXY] ✗ Network error on ${modelName}: ${err.code || err.message}`);
      markModelFailure(modelId, `${err.code || err.message}`);

      // 继续尝试下一个模型
      const newTried = [...triedModels, modelId];
      setTimeout(() => {
        upstreamRequest(payload, newTried, depth + 1).then(resolve);
      }, CONFIG.failover.retryDelay);
    });

    req.on('timeout', () => {
      req.destroy();
      console.error(`[PROXY] ✗ Timeout on ${modelName}`);
      markModelFailure(modelId, 'Timeout');

      const newTried = [...triedModels, modelId];
      setTimeout(() => {
        upstreamRequest(payload, newTried, depth + 1).then(resolve);
      }, CONFIG.failover.retryDelay);
    });

    req.write(postData);
    req.end();
  });
}


// ========== 流式请求封装（带故障切换） ==========

/**
 * 流式请求的故障切换版本
 * 注意：流式一旦开始写入 response，就不能切换了；所以只在连接建立前做切换
 */
function handleStreamWithFailover(originalReq, originalRes, payload, originalBody, triedModels = [], depth = 0) {
  const modelId = getNextModel(triedModels);

  if (!modelId || depth >= CONFIG.failover.maxRetries) {
    console.error(`[PROXY] ✗ All stream models exhausted. Tried: ${triedModels.join(', ')}`);
    // 尝试发送一个错误事件给客户端
    try {
      originalRes.write(`event: error\ndata: ${JSON.stringify({ error: 'All models failed', tried_models: triedModels })}\n\n`);
    } catch (e) { /* ignore */ }
    originalRes.end();
    return;
  }

  const actualPayload = { ...payload, model: modelId };
  const postData = JSON.stringify(actualPayload);
  const modelName = modelHealth.get(modelId)?.name || modelId;

  if (depth === 0) {
    console.log(`[PROXY] → Stream primary: ${modelName} (${modelId})`);
  } else {
    console.log(`[PROXY] → Stream failover #${depth}: ${modelName} (${modelId})`);
  }

  const options = {
    hostname: CONFIG.upstream.host,
    port: 443,
    path: CONFIG.upstream.path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.upstream.apiKey}`,
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  const upReq = https.request(options, (upRes) => {
    // 检查上游是否返回了错误状态码（还没开始发数据）
    if (upRes.statusCode >= 400) {
      console.error(`[PROXY] ✗ Stream model ${modelName} returned HTTP ${upRes.statusCode}`);

      // 收集错误响应体
      const errorChunks = [];
      upRes.on('data', c => errorChunks.push(c));
      upRes.on('end', () => {
        const errBody = Buffer.concat(errorChunks).toString();
        let errMsg = `HTTP ${upRes.statusCode}`;
        try {
          const parsed = JSON.parse(errBody);
          errMsg = parsed?.error?.message || errMsg;
        } catch (e) { /* use raw */ }
        console.error(`[PROXY]   Stream error body: ${errBody.slice(0, 500)}`);
        console.error(`[PROXY]   Sent payload keys: ${Object.keys(payload).join(', ')}`);
        if (payload.tools) console.error(`[PROXY]   tools count: ${payload.tools.length}`);
        markModelFailure(modelId, errMsg);

        // 切换到下一个模型
        setTimeout(() => {
          handleStreamWithFailover(originalReq, originalRes, payload, originalBody, [...triedModels, modelId], depth + 1);
        }, CONFIG.failover.retryDelay);
      });
      return;
    }

    // ========== 上游连接成功，开始流式转发 ==========
    // OpenAI Responses API SSE 事件格式 (Codex CLI 期望的精确格式)
    // 基于阿里云百炼官方 Responses API 兼容文档 (v3.4 修正版)
    //
    // 完整的事件生命周期 (10 阶段):
    //   1. event: response.created              -> 声明响应对象
    //   2. event: response.in_progress           -> 标记开始生成
    //   3. event: response.output_item.added     -> 声明输出项(仅一次)
    //   4. event: response.content_part.added    -> 声明内容块(仅一次)
    //   5. event: response.output_text.delta ×N  -> 文本增量(多次)
    //   6. event: response.output_text.done      -> 文本输出完成 (v3.4 新增!)
    //   7. event: response.content_part.done     -> 内容块完成
    //   8. event: response.output_item.done      -> 输出项完成
    //   9. event: response.completed             -> 响应完成(必须用 {type, response} 包装!)
    //  10. event: response.done                  -> 整个流结束

    originalRes.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const respId = `resp_${Date.now()}`;
    let buffer = '';
    let itemAdded = false;   // 是否已发送 output_item.added
    let partAdded = false;   // 是否已发送 content_part.added
    let fullText = '';       // 收集完整文本

    // 标记模型成功（至少连接建立了）
    markModelSuccess(modelId);

    // === 阶段 1-2: 响应创建 + 开始生成 ===
    originalRes.write(`event: response.created\ndata: ${JSON.stringify({
      id: respId,
      object: 'response',
      status: 'in_progress',
      created_at: Math.floor(Date.now() / 1000),
    })}\n\n`);

    originalRes.write(`event: response.in_progress\ndata: ${JSON.stringify({
      id: respId,
      status: 'in_progress',
    })}\n\n`);

    upRes.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();

        if (data === '[DONE]') {
          // === 阶段 6-9: output_text.done / content_part.done / output_item.done / response.completed ===
          // v3.4: 构建带完整字段的输出项结构 (FIX 3 + FIX 4)
          const msgItemId = 'msg_' + respId;
          const finalContentItem = { type: 'output_text', text: fullText, annotations: [] };
          const finalOutputItem = {
            id: msgItemId,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [finalContentItem],
          };

          if (!itemAdded) {
            // 如果上游没发任何内容（空回复），仍需发送完整的骨架事件
            originalRes.write(`event: response.output_item.added\ndata: ${JSON.stringify({
              type: 'response.output_item.added',
              output_index: 0,
              item: finalOutputItem,
            })}\n\n`);
            itemAdded = true;
          }

          if (!partAdded) {
            originalRes.write(`event: response.content_part.added\ndata: ${JSON.stringify({
              type: 'response.content_part.added',
              output_index: 0,
              content_index: 0,
              part: { type: 'output_text', text: '' },
            })}\n\n`);
            partAdded = true;
          }

          // ===== 阶段 6 (v3.4 新增!): response.output_text.done =====
          // FIX 1: 这个事件在 v3.3 中完全缺失! Codex 可能依赖它来判断文本输出结束
          originalRes.write(`event: response.output_text.done\ndata: ${JSON.stringify({
            type: 'response.output_text.done',
            text: fullText,
            item_id: msgItemId,
            output_index: 0,
            content_index: 0,
          })}\n\n`);

          // ===== 阶段 7: response.content_part.done =====
          originalRes.write(`event: response.content_part.done\ndata: ${JSON.stringify({
            type: 'response.content_part.done',
            output_index: 0,
            content_index: 0,
            part: finalContentItem,
          })}\n\n`);

          // ===== 阶段 8: response.output_item.done =====
          originalRes.write(`event: response.output_item.done\ndata: ${JSON.stringify({
            type: 'response.output_item.done',
            output_index: 0,
            item: finalOutputItem,
          })}\n\n`);

          // ===== 阶段 9: response.completed (v3.4 关键修复!) =====
          // FIX 2: 必须用 {type: "response.completed", response: {...}} 包装!
          // Codex CLI 解析此事件来确认响应完整性的关键是这个嵌套结构
          originalRes.write(`event: response.completed\ndata: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: respId,
              object: "response",
              status: "completed",
              created_at: Math.floor(Date.now() / 1000),
              output: [finalOutputItem],
              usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            },
          })}\n\n`);
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            fullText += delta.content;

            // === 阶段 3: 首次收到内容时发送 output_item.added (仅一次) ===
            // v3.4: 添加 type/id/status/annotations 字段
            if (!itemAdded) {
              const msgItemId = 'msg_' + respId;
              originalRes.write(`event: response.output_item.added\ndata: ${JSON.stringify({
                type: 'response.output_item.added',
                output_index: 0,
                item: {
                  id: msgItemId,
                  type: 'message',
                  role: 'assistant',
                  status: 'in_progress',
                  content: [{ type: 'output_text', text: '', annotations: [] }],
                },
              })}\n\n`);
              itemAdded = true;
            }

            // === 阶段 4: 首次收到内容时发送 content_part.added (仅一次) ===
            // v3.4: 使用 type 字段替代 object
            if (!partAdded) {
              originalRes.write(`event: response.content_part.added\ndata: ${JSON.stringify({
                type: 'response.content_part.added',
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: '' },
              })}\n\n`);
              partAdded = true;
            }

            // === 阶段 5: 发送文本增量 (每次有新内容都发) ===
            // v3.4: 使用 type 字段替代 object
            originalRes.write(`event: response.output_text.delta\ndata: ${JSON.stringify({
              type: 'response.output_text.delta',
              output_index: 0,
              content_index: 0,
              delta: delta.content,
            })}\n\n`);
          }
        } catch (e) {
          // 忽略解析错误（可能是非 JSON 数据行）
        }
      }
    });

    upRes.on('end', () => {
      // === 阶段 10: 整个流结束 ===
      // v3.4: 使用 type 字段
      originalRes.write(`event: response.done\ndata: ${JSON.stringify({
        type: 'response.done',
        response: {
          id: respId,
          object: 'response',
          status: 'completed',
        },
      })}\n\n`);

      originalRes.end();
      console.log(`[PROXY] ✓ Stream completed via ${modelName} (${fullText.length} chars)`);
    });

    upRes.on('error', (err) => {
      console.error(`[PROXY] ✗ Upstream stream error on ${modelName}:`, err.message);
      markModelFailure(modelId, err.message);
      try { originalRes.end(); } catch (e) { /* already closed */ }
    });
  });

  upReq.on('error', (err) => {
    // 连接级别的错误 — 可以安全地切换到下一个模型（因为还没写任何数据到 originalRes）
    console.error(`[PROXY] ✗ Stream connection error on ${modelName}: ${err.code || err.message}`);
    markModelFailure(modelId, `${err.code || err.message}`);

    setTimeout(() => {
      handleStreamWithFailover(originalReq, originalRes, payload, originalBody, [...triedModels, modelId], depth + 1);
    }, CONFIG.failover.retryDelay);
  });

  upReq.setTimeout(300000);
  upReq.write(postData);
  upReq.end();
}


// ========== 核心代理逻辑 ==========

async function handleRequest(req, res) {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    });
    res.end();
    return;
  }

  // 只处理 /v1/responses 路径
  if (req.url.startsWith('/v1/responses')) {
    const body = await parseBody(req);
    if (!body) {
      sendJson(res, 400, { error: 'Invalid request body' });
      return;
    }

    // 构造 Chat Completions 请求（模型将由故障切换逻辑动态选择）
    const messages = inputToMessages(body.input);
    const chatPayload = {
      messages: messages,
      temperature: body.temperature ?? 0.7,
      max_tokens: body.max_output_tokens ?? 16384,
      top_p: body.top_p,
      stream: body.stream || false,
      // 注意：SiliconFlow 免费模型/L0 等级不支持 function calling (tools)
      // 如果传 tools 会导致 "Field required" 错误，所以这里不传
      // Codex 的 tool_use 指令会以纯文本形式包含在消息中，模型仍可理解
      // tools: body.tools,  // 已禁用 - SiliconFlow 不支持
    };

    // 详细调试日志：打印实际发送的 payload 结构
    console.log(`[PROXY] Incoming request: model=${body.model || '(none)'}, stream=${chatPayload.stream}`);
    if (body.tools && body.tools.length > 0) {
      console.log(`[PROXY] ⚠ Dropped ${body.tools.length} tools (SiliconFlow doesn't support function calling)`);
    }
    console.log(`[PROXY] Messages (${messages.length}):`);
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const contentPreview = typeof m.content === 'string' ? m.content.slice(0, 80) : `[${typeof m.content}]`;
      console.log(`  [${i}] role=${m.role}, content="${contentPreview}"`);
    }
    if (chatPayload.tools && chatPayload.tools.length > 0) {
      console.log(`[PROXY] Tools (${chatPayload.tools.length}):`);
      for (let i = 0; i < Math.min(chatPayload.tools.length, 3); i++) {
        const t = chatPayload.tools[i];
        console.log(`  [${i}] ${JSON.stringify(t).slice(0, 200)}`);
      }
      if (chatPayload.tools.length > 3) {
        console.log(`  ... and ${chatPayload.tools.length - 3} more tools`);
      }
    }

    // 流式 / 非流式分别处理
    if (chatPayload.stream) {
      handleStreamWithFailover(req, res, chatPayload, body);
    } else {
      // 非流式：用带故障切换的上游请求
      const result = await upstreamRequest(chatPayload);

      if (result.status >= 400) {
        console.log(`[PROXY] ✗ All models failed:`, JSON.stringify(result.data)?.slice(0, 300));
        sendJson(res, result.status, result.data);
        return;
      }

      const responseObj = chatToResponse(result.data, null, result.usedModel);
      console.log(`[PROXY] ✓ Response OK via ${result.usedModel} (${result.data.usage?.total_tokens || '?'} tokens)`);
      sendJson(res, 200, responseObj);
    }
    return;
  }

  // 其他路径透传
  passthrough(req, res);
}

/** 透传非 /v1/responses 路径 */
function passthrough(req, res) {
  console.log(`[PROXY] → Passthrough: ${req.method} ${req.url}`);
  if (req.url.includes('/models')) {
    // 返回模型池中所有模型的信息
    const modelList = MODEL_POOL.map(m => ({
      id: m.id,
      object: 'model',
      owned_by: 'siliconflow',
      description: m.desc,
    }));
    sendJson(res, 200, { object: 'list', data: modelList, total: modelList.length });
    return;
  }

  sendJson(res, 404, { error: 'Not found. This proxy only handles /v1/responses' });
}


// ========== 启动时连通性测试 ==========

/**
 * 启动前逐个测试模型池中每个模型的连通性
 * - 发送一个最小请求到每个模型
 * - 标记可用/不可用
 * - 如果全部不可用，打印警告但仍然启动（可能临时问题）
 */
function testModelConnectivity() {
  return new Promise((resolve) => {
    console.log('\n[CONNECTIVITY TEST] Testing connection to SiliconFlow...');
    console.log(`  Target: https://${CONFIG.upstream.host}${CONFIG.upstream.path}`);
    console.log(`  Models to test: ${MODEL_POOL.length}\n`);

    let completed = 0;
    const total = MODEL_POOL.length;
    const results = [];

    for (const model of MODEL_POOL) {
      const testData = JSON.stringify({
        model: model.id,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      });

      const options = {
        hostname: CONFIG.upstream.host,
        port: 443,
        path: CONFIG.upstream.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.upstream.apiKey}`,
          'Content-Length': Buffer.byteLength(testData),
        },
        timeout: 15000, // 每个模型最多等15秒
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          completed++;
          const ok = res.statusCode >= 200 && res.statusCode < 400;
          const errMsg = !ok ? ((() => { try { return JSON.parse(body)?.error?.message || `HTTP ${res.statusCode}`; } catch(e) { return `HTTP ${res.statusCode}`; }})()) : null;

          results.push({ id: model.id, name: model.name, ok, status: res.statusCode, error: errMsg });
          markModelHealthTestResult(model.id, ok, errMsg);

          if (completed === total) {
            printTestResults(results);
            resolve(results);
          }
        });
      });

      req.on('error', (err) => {
        completed++;
        results.push({ id: model.id, name: model.name, ok: false, status: 0, error: err.code || err.message });
        markModelHealthTestResult(model.id, false, err.code || err.message);

        if (completed === total) {
          printTestResults(results);
          resolve(results);
        }
      });

      req.on('timeout', () => {
        req.destroy();
        completed++;
        results.push({ id: model.id, name: model.name, ok: false, status: 0, error: 'Timeout' });
        markModelHealthTestResult(model.id, false, 'Timeout');

        if (completed === total) {
          printTestResults(results);
          resolve(results);
        }
      });

      req.write(testData);
      req.end();
    }
  });
}

/** 记录测试结果到模型健康状态 */
function markModelHealthTestResult(modelId, ok, error) {
  const h = modelHealth.get(modelId);
  if (!h) return;
  if (ok) {
    h.lastSuccessTime = Date.now();
    h.totalSuccesses++;
  } else {
    h.lastError = error;
    h.lastErrorTime = Date.now();
    h.totalFailures++;
    h.consecutiveFailures = 1;
  }
}

/** 打印测试结果汇总表 */
function printTestResults(results) {
  console.log('┌──────────────────────────────────┬────────┬──────────────────────────────┐');
  console.log('│ Model                            │ Status │ Detail                       │');
  console.log('├──────────────────────────────────┼────────┼──────────────────────────────┤');

  let okCount = 0;
  let failCount = 0;

  for (const r of results) {
    const icon = r.ok ? '\u2713' : '\u2717'; // ✓ or ✗
    const name = r.name.padEnd(33);
    const status = r.ok ? '  OK   '.padEnd(8) : ' FAIL  '.padEnd(8);
    const detail = r.ok
      ? `HTTP ${r.status}`
      : (r.error || 'Unknown').slice(0, 28);

    console.log(`│ ${icon} ${name} │${status}│ ${detail.padEnd(29)}│`);

    if (r.ok) okCount++; else failCount++;
  }

  console.log('└──────────────────────────────────┴────────┴──────────────────────────────┘');
  console.log(`  Result: ${okCount}/${results.length} models available, ${failCount} failed\n`);

  if (failCount === results.length) {
    console.error('  ╔══════════════════════════════════════════════════╗');
    console.error('  ║  WARNING: ALL MODELS FAILED CONNECTIVITY TEST!   ║');
    console.error('  ╠══════════════════════════════════════════════════╣');
    console.error('  ║  Possible causes:                               ║');
    console.error('  ║  1. Account balance insufficient (need top-up)  ║');
    console.error('  ║  2. API key expired or invalid                  ║');
    console.error('  ║  3. Network cannot reach api.siliconflow.cn     ║');
    console.error('  ║  4. Model not available on your account         ║');
    console.error('  ╠══════════════════════════════════════════════════╣');
    console.error('  ║  Proxy will still start, but requests will      ║');
    console.error('  ║  likely fail until the issue is fixed.          ║');
    console.error('  ╚══════════════════════════════════════════════════╝\n');
  } else if (failCount > 0) {
    console.log(`  Note: ${failCount} model(s) failed. They will be skipped during failover until they recover.\n`);
  }
}


// ========== 启动服务器 ==========

const server = http.createServer(handleRequest);

server.listen(CONFIG.port, CONFIG.host, async () => {
  // 先做连通性测试，测试完再打印启动面板
  await testModelConnectivity();

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   SiliconFlow Proxy for Codex CLI  v3.4         ║');
  console.log('║   Responses <-> Chat Completions               ║');
  console.log('║   Multi-Model Pool + Auto Failover             ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║   Listen : http://${CONFIG.host}:${CONFIG.port}/v1`);
  console.log(`║   Target : https://${CONFIG.upstream.host}${CONFIG.upstream.path}`);
  console.log(`║   Base URL: https://${CONFIG.upstream.host}/v1`);
  console.log(`║   Models : ${MODEL_POOL.length} in pool`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║   Model Pool:                                    ║');
  for (let i = 0; i < MODEL_POOL.length; i++) {
    const m = MODEL_POOL[i];
    console.log(`║     ${i + 1}. ${m.id.padEnd(48)} ║`);
  }
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  printModelPoolStatus();
  console.log('Ready! Now start Codex.');
  console.log('');

  // 每60秒打印一次模型状态（方便调试）
  setInterval(() => {
    // 只在有失败记录时打印
    let hasFailures = false;
    for (const [, h] of modelHealth) {
      if (h.consecutiveFailures > 0) { hasFailures = true; break; }
    }
    if (hasFailures) {
      printModelPoolStatus();
    }
  }, 60000);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const { execSync } = require('child_process');
    console.error(`\n[X] Port ${CONFIG.port} is already in use!`);
    console.error(`[!] Attempting to auto-kill process on port ${CONFIG.port}...\n`);
    try {
      const result = execSync(`netstat -ano | findstr ":${CONFIG.port} " | findstr "LISTENING"`, { encoding: 'utf8' });
      const pids = result.trim().split(/\s+/).filter((_, i, arr) => i === arr.length - 1 && /^\d+$/.test(_));
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { encoding: 'utf8' });
          console.error(`  [OK] Killed PID ${pid}`);
        } catch (e2) {
          console.error(`  [!] Failed to kill PID ${pid} (may need admin rights)`);
        }
      }
      console.error('\n[*] Retrying in 3 seconds...');
      setTimeout(() => server.listen(CONFIG.port, CONFIG.host), 3000);
      return;
    } catch (e) {
      console.error('[X] Auto-kill failed. Please close manually:\n');
      console.error(`  netstat -ano | findstr ":${CONFIG.port}"`);
      console.error('  taskkill /PID <PID> /F\n');
      process.exit(1);
    }
  } else {
    console.error('[ERROR]', err);
    process.exit(1);
  }
});
