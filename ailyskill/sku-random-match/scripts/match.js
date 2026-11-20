#!/usr/bin/env node
/**
 * 随机款SKU匹配 — Aily 技能核心脚本（零依赖，纯 HTTP 直调飞书 OpenAPI）
 *
 * 业务规则：
 * - 订单详情表（含「随机款SKU」字段的表，自动识别）：随机款SKU | 订单号 | 仓库 | 实际发货SKU | 状态(已匹配/缺货/失败) | 备注 | 匹配时间
 * - 前缀表们（手动添加，表名=前缀，如 twh / RS1）：实际SKU | 仓库 | 数量（库存可随时人工改）
 * - 抽取次数从随机款SKU解析：-(\d+)p- 段（twh-2p-xxx → 2次）；无 Np 默认 1 次
 * - 前缀→前缀表：表名能作为SKU开头前缀（SKU 以 表名+"-" 开头）中最长者
 * - 合格池：仓库相同 且 数量>=10；抽中一次数量-1；降到 10 以下移出池
 * - 抽不满：已抽的写入，状态=缺货，备注缺几个；找不到前缀表：状态=失败
 * - 只处理「有SKU且状态为空」的行；已处理的行不会重复匹配
 *
 * 配置来源（优先级从高到低）：
 *   1. 命令行 --base-token / --app-id / --app-secret
 *   2. 环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET / BASE_TOKEN
 *   3. 技能根目录 config.json（从 config.example.json 复制）
 *
 * 用法：
 *   node scripts/match.js             # 执行匹配并写回
 *   node scripts/match.js --dry-run   # 只预览，不写任何数据
 *   node scripts/match.js --help
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FLOOR = 10;               // 数量低于此值跳过
const MATCH_TABLE = '匹配表';

// ---------------- 参数解析 ----------------

function parseArgs(argv) {
  const args = { dryRun: false, baseToken: '', appId: '', appSecret: '', orderTable: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--base-token') args.baseToken = argv[++i] || '';
    else if (a === '--app-id') args.appId = argv[++i] || '';
    else if (a === '--app-secret') args.appSecret = argv[++i] || '';
    else if (a === '--order-table') args.orderTable = argv[++i] || '';
    else if (a === '--help' || a === '-h') {
      console.log([
        '用法: node scripts/match.js [选项]',
        '  --dry-run             只预览匹配计划，不写任何数据',
        '  --base-token <token>  覆盖多维表格 token',
        '  --app-id <id>         覆盖应用 app_id',
        '  --app-secret <s>      覆盖应用 app_secret',
        '  --order-table <name>  指定订单详情表名（默认自动识别）',
        '配置: 环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET / BASE_TOKEN，',
        '      或技能根目录 config.json（见 config.example.json）',
      ].join('\n'));
      process.exit(0);
    }
  }
  return args;
}

function loadConfig(args) {
  const env = {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    baseToken: process.env.BASE_TOKEN || '',
    orderTable: process.env.FEISHU_ORDER_TABLE || '',
  };
  let file = {};
  const cfgPath = path.join(__dirname, '..', 'config.json');
  if (fs.existsSync(cfgPath)) {
    try { file = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { /* 忽略坏配置 */ }
  }
  return {
    appId: args.appId || env.appId || file.appId || '',
    appSecret: args.appSecret || env.appSecret || file.appSecret || '',
    baseToken: args.baseToken || env.baseToken || file.baseToken || '',
    orderTable: args.orderTable || env.orderTable || file.orderTable || '',
  };
}

// ---------------- 飞书 OpenAPI ----------------

async function http(method, url, headers, body) {
  const opts = { method, headers };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error(`响应非JSON (HTTP ${res.status} ${method} ${url}): ${text.slice(0, 300)}`); }
  if (json.code !== 0) {
    throw new Error(`飞书API错误 code=${json.code} msg=${json.msg} (HTTP ${res.status})`);
  }
  return json; // 返回整个响应（部分接口字段在顶层，如 tenant_access_token）
}

async function getTenantToken(appId, appSecret) {
  const json = await http(
    'POST',
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { 'Content-Type': 'application/json; charset=utf-8' },
    { app_id: appId, app_secret: appSecret }
  );
  return json.tenant_access_token;
}

// ---------------- Base 数据读写 ----------------

async function listTables(token, baseToken) {
  const json = await http(
    'GET',
    `https://open.feishu.cn/open-apis/base/v3/bases/${baseToken}/tables?page_size=100`,
    { Authorization: `Bearer ${token}` }
  );
  return (json.data && json.data.tables) || [];
}

// 分页拉全表记录（base/v3 列式结构：fields + record_id_list + data 二维数组）
function parseColumnar(json) {
  const d = json.data || {};
  const fields = d.fields || [];
  const rows = d.data || [];
  const ids = d.record_id_list || [];
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const rec = { record_id: ids[i], fields: {} };
    const cells = rows[i] || [];
    for (let j = 0; j < fields.length; j++) rec.fields[fields[j]] = cells[j];
    out.push(rec);
  }
  return { records: out, hasMore: !!d.has_more };
}

async function listAllRecords(token, baseToken, tableId) {
  const all = [];
  let offset = 0;
  for (;;) {
    const url = `https://open.feishu.cn/open-apis/base/v3/bases/${baseToken}/tables/${tableId}/records?page_size=500&offset=${offset}`;
    const json = await http('GET', url, { Authorization: `Bearer ${token}` });
    const { records, hasMore } = parseColumnar(json);
    all.push(...records);
    if (!hasMore || records.length === 0) break;
    offset += records.length;
  }
  return all;
}

async function updateRecord(token, baseToken, tableId, recordId, fields) {
  // base/v3 单条更新：PATCH，body 是裸字段映射（不要 {fields:...} 包装）
  return http(
    'PATCH',
    `https://open.feishu.cn/open-apis/base/v3/bases/${baseToken}/tables/${tableId}/records/${recordId}`,
    { Authorization: `Bearer ${token}` },
    fields
  );
}

// ---------------- 单元格取值 ----------------

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((s) => (typeof s === 'string' ? s : (s && s.text) || '')).join('');
  if (typeof v === 'object' && v.text != null) return String(v.text);
  return String(v);
}

function cellSelect(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.length ? String(v[0]) : '';
  return String(v);
}

function cellNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------- 匹配逻辑 ----------------

function parseDrawCount(sku) {
  const m = String(sku).match(/-(\d+)p(?=-|$)/);
  return m ? parseInt(m[1], 10) : 1;
}

function findPrefixTable(tables, orderTableId, sku) {
  let best = null;
  const lower = String(sku).toLowerCase();
  for (const t of tables) {
    if (t.id === orderTableId) continue; // 订单详情表本身不是前缀池
    const name = t.name.toLowerCase();
    if (lower.startsWith(name + '-') && (!best || name.length > best.name.length)) {
      best = t;
    }
  }
  return best;
}

function compact(drawLog) {
  const counts = new Map();
  for (const s of drawLog) counts.set(s, (counts.get(s) || 0) + 1);
  return [...counts.entries()].map(([s, c]) => (c > 1 ? `${s}×${c}` : s)).join(', ');
}

// 定位订单详情表：优先 config 里指定的表名 → 常见名称 → 扫描含「随机款SKU」字段的表
async function findOrderTable(token, baseToken, tables, cfgOrderTable) {
  if (cfgOrderTable) {
    const byName = tables.find((t) => t.name === cfgOrderTable);
    if (byName) return byName;
  }
  for (const name of ['订单详情表', MATCH_TABLE]) {
    const byName = tables.find((t) => t.name === name);
    if (byName) return byName;
  }
  for (const t of tables) {
    const json = await http(
      'GET',
      `https://open.feishu.cn/open-apis/base/v3/bases/${baseToken}/tables/${t.id}/fields?page_size=100`,
      { Authorization: `Bearer ${token}` }
    );
    const names = ((json.data && json.data.fields) || []).map((f) => f.name);
    if (names.includes('随机款SKU')) return t;
  }
  return null;
}

async function runMatch(cfg, dryRun) {
  if (!cfg.appId || !cfg.appSecret) {
    throw new Error('缺少应用凭据：请配置 FEISHU_APP_ID / FEISHU_APP_SECRET（或 config.json）');
  }
  if (!cfg.baseToken) {
    throw new Error('缺少多维表格 token：请配置 BASE_TOKEN（或 config.json）');
  }

  const token = await getTenantToken(cfg.appId, cfg.appSecret);
  const tables = await listTables(token, cfg.baseToken);

  const orderTable = await findOrderTable(token, cfg.baseToken, tables, cfg.orderTable);
  if (!orderTable) {
    throw new Error('多维表格里找不到订单详情表（需有「随机款SKU」字段的表，或名为 匹配表/订单详情表）');
  }

  const rows = (await listAllRecords(token, cfg.baseToken, orderTable.id)).filter((r) => {
    const f = r.fields || {};
    return cellText(f['随机款SKU']).trim() !== '' && !cellSelect(f['状态']);
  });

  const summary = { matched: [], short: [], failed: [], none: rows.length === 0, updatedSkuRows: 0 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const row of rows) {
    const f = row.fields || {};
    const sku = cellText(f['随机款SKU']).trim();
    const warehouse = cellSelect(f['仓库']);
    const orderNo = cellText(f['订单号']).trim();
    const label = orderNo ? `${sku} (${orderNo})` : sku;
    const n = parseDrawCount(sku);
    const table = findPrefixTable(tables, orderTable.id, sku);

    if (!table) {
      summary.failed.push(`${label} → 未找到前缀表`);
      if (!dryRun) {
        await updateRecord(token, cfg.baseToken, orderTable.id, row.record_id, {
          '状态': '失败', '备注': '未找到前缀表', '匹配时间': Date.now(),
        });
        await sleep(500);
      }
      continue;
    }

    const pool = (await listAllRecords(token, cfg.baseToken, table.id))
      .map((r) => {
        const pf = r.fields || {};
        return {
          record_id: r.record_id,
          sku: cellText(pf['实际SKU']).trim(),
          warehouse: cellSelect(pf['仓库']),
          qty: cellNumber(pf['数量']),
        };
      })
      .filter((p) => p.sku && p.warehouse === warehouse && p.qty >= FLOOR);

    const drawLog = [];
    const alive = pool.slice();

    for (let i = 0; i < n; i++) {
      if (alive.length === 0) break;
      const idx = Math.floor(Math.random() * alive.length);
      const picked = alive[idx];
      drawLog.push(picked.sku);
      picked.qty -= 1;
      picked.drawn = (picked.drawn || 0) + 1;
      if (picked.qty < FLOOR) alive.splice(idx, 1);
    }

    const short = n - drawLog.length;

    // 写回前缀表数量（只写被抽过的行）
    for (const p of pool) {
      if (!p.drawn) continue;
      if (dryRun) {
        summary.updatedSkuRows += 1;
        continue;
      }
      await updateRecord(token, cfg.baseToken, table.id, p.record_id, { '数量': p.qty });
      summary.updatedSkuRows += 1;
      await sleep(500);
    }

    if (short === 0) {
      summary.matched.push(`${label} → ${compact(drawLog)}`);
      if (!dryRun) {
        await updateRecord(token, cfg.baseToken, orderTable.id, row.record_id, {
          '实际发货SKU': compact(drawLog), '状态': '已匹配', '备注': '', '匹配时间': Date.now(),
        });
      }
    } else {
      summary.short.push(`${label} → ${drawLog.length ? compact(drawLog) : '无'}（缺${short}个）`);
      if (!dryRun) {
        await updateRecord(token, cfg.baseToken, orderTable.id, row.record_id, {
          '实际发货SKU': drawLog.length ? compact(drawLog) : '',
          '状态': '缺货', '备注': `缺${short}个`, '匹配时间': Date.now(),
        });
      }
    }
    await sleep(500);
  }

  return summary;
}

function formatSummary(s) {
  if (s.none) return '没有待匹配的行（有随机款SKU且状态为空才算待匹配）。';
  const lines = [`共处理 ${s.matched.length + s.short.length + s.failed.length} 行：`];
  if (s.matched.length) lines.push(`\n【已匹配 ${s.matched.length}】`, ...s.matched.map((x) => '· ' + x));
  if (s.short.length) lines.push(`\n【缺货 ${s.short.length}】`, ...s.short.map((x) => '· ' + x));
  if (s.failed.length) lines.push(`\n【失败 ${s.failed.length}】`, ...s.failed.map((x) => '· ' + x));
  lines.push(`\n（子表数量已扣减 ${s.updatedSkuRows} 行，请以多维表格为准）`);
  return lines.join('\n');
}

// ---------------- 入口 ----------------

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args);
  runMatch(cfg, args.dryRun)
    .then((summary) => {
      console.log(formatSummary(summary));
    })
    .catch((err) => {
      console.error('❌ 匹配失败：' + err.message);
      process.exit(1);
    });
}

module.exports = { runMatch, formatSummary, parseDrawCount };
