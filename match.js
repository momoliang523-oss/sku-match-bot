#!/usr/bin/env node
/**
 * 随机款 SKU 匹配核心
 *
 * 规则（与用户确认）：
 * - 匹配表：随机款SKU | 订单号 | 仓库 | 实际发货SKU | 状态 | 备注 | 匹配时间
 * - 前缀子表（表名=前缀，如 twh / twh-1p）：实际SKU | 仓库 | 数量
 * - 抽取次数从随机款SKU解析：-(\d+)p- 段（twh-2p-xxx → 2 次）；无 Np 默认 1
 * - 前缀→子表：表名能作为 SKU 开头前缀（SKU 以 表名+"-" 开头）中最长者
 * - 合格池：仓库相同 且 数量 >= 10；抽中一次数量-1；数量降到 10 以下移出池
 * - 抽不满：已抽到的写入，状态=缺货，备注缺几个；找不到前缀表：状态=失败
 * - 只处理状态为空的待匹配行
 *
 * 用法：node match.js
 * 输出：最后一行打印 JSON 摘要（供机器人回复使用）
 */

const { execFileSync, execFile } = require('child_process');
const path = require('path');

const BASE_TOKEN = process.env.BASE_TOKEN || '';
const MATCH_TABLE = '匹配表';
const FLOOR = 10; // 数量低于此值跳过

// ---------- lark-cli 封装 ----------

function larkJson(args, identity = 'bot') {
  const out = execFileSync('lark-cli', [...args, '--as', identity], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  // 输出是一份 JSON 文档，可能带前导/尾部提示文本：取第一个 { 到最后一个 } 之间
  const first = out.indexOf('{');
  const last = out.lastIndexOf('}');
  if (first < 0 || last < first) {
    throw new Error(`lark-cli 无 JSON 输出 [${args.slice(0, 3).join(' ')}]: ` + out.slice(0, 500));
  }
  try {
    return JSON.parse(out.slice(first, last + 1));
  } catch (e) {
    throw new Error(`lark-cli 输出解析失败 [${args.slice(0, 3).join(' ')}]: ${e.message} — 原始输出: ${out.slice(0, 600)}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 分页拉全表记录（offset 模式）
// record-list 返回列式结构：fields + field_id_list + record_id_list + data(二维数组，行与 record_id_list 对齐)
function listAllRecords(tableId, identity = 'bot') {
  const all = [];
  let offset = 0;
  for (;;) {
    const res = larkJson(
      ['base', '+record-list', '--base-token', BASE_TOKEN, '--table-id', tableId,
       '--format', 'json', '--limit', '200', '--offset', String(offset)],
      identity
    );
    const d = res.data || {};
    const fields = d.fields || [];
    const rows = d.data || [];
    const ids = d.record_id_list || [];
    for (let i = 0; i < rows.length; i++) {
      const rec = { record_id: ids[i], fields: {} };
      const cells = rows[i] || [];
      for (let j = 0; j < fields.length; j++) rec.fields[fields[j]] = cells[j];
      all.push(rec);
    }
    if (!d.has_more || rows.length === 0) break;
    offset += rows.length;
  }
  return all;
}

// 单元格值 → 文本（text 可能是段数组）
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((s) => (typeof s === 'string' ? s : s.text || '')).join('');
  if (typeof v === 'object' && v.text != null) return String(v.text);
  return String(v);
}

// 单选值可能是字符串或数组，取第一个
function cellSelect(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.length ? String(v[0]) : '';
  return String(v);
}

// 数量
function cellNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------- 匹配逻辑 ----------

// 解析抽取次数：-(\d+)p- 或 -(\d+)p 结尾；无则默认 1
function parseDrawCount(sku) {
  const m = String(sku).match(/-(\d+)p(?=-|$)/);
  return m ? parseInt(m[1], 10) : 1;
}

// 找最长前缀子表
function findPrefixTable(tables, sku) {
  let best = null;
  for (const t of tables) {
    if (t.name === MATCH_TABLE) continue;
    if (sku.startsWith(t.name + '-') && (!best || t.name.length > best.name.length)) {
      best = t;
    }
  }
  return best;
}

function compact(drawLog) {
  const counts = new Map();
  for (const s of drawLog) counts.set(s, (counts.get(s) || 0) + 1);
  return [...counts.entries()]
    .map(([s, c]) => (c > 1 ? `${s}×${c}` : s))
    .join(', ');
}

function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 更新一条记录（串行调用，调用方负责间隔）
function upsert(tableId, recordId, fields, identity = 'bot') {
  const res = larkJson(
    ['base', '+record-upsert', '--base-token', BASE_TOKEN, '--table-id', tableId,
     '--record-id', recordId, '--json', JSON.stringify(fields)],
    identity
  );
  if (!res.ok) throw new Error('upsert 失败: ' + JSON.stringify(res.error || res));
  return res;
}

/**
 * 执行一轮匹配
 * @param {string} identity 'bot' | 'user'
 * @returns 摘要 {matched, short, failed, updatedSkuRows, error}
 */
async function runMatch(identity = 'bot') {
  const tables = larkJson(
    ['base', '+table-list', '--base-token', BASE_TOKEN],
    identity
  ).data.tables;

  const matchTable = tables.find((t) => t.name === MATCH_TABLE);
  if (!matchTable) throw new Error('找不到「' + MATCH_TABLE + '」表');

  // 待匹配行：有随机款SKU 且 状态为空（空数组/空串/null 都算待匹配）
  const rows = listAllRecords(matchTable.id, identity).filter(
    (r) => cellText((r.fields || {})['随机款SKU']).trim() !== '' && !cellSelect((r.fields || {})['状态'])
  );

  const summary = { matched: [], short: [], failed: [], none: rows.length === 0, updatedSkuRows: 0 };

  for (const row of rows) {
    const f = row.fields || {};
    const sku = cellText(f['随机款SKU']).trim();
    const warehouse = cellSelect(f['仓库']);
    const orderNo = cellText(f['订单号']).trim();
    const label = orderNo ? `${sku} (${orderNo})` : sku;

    if (!sku) continue;

    const n = parseDrawCount(sku);
    const table = findPrefixTable(tables, sku);

    if (!table) {
      summary.failed.push(`${label} → 未找到前缀表`);
      await upsert(matchTable.id, row.record_id, {
        '状态': '失败',
        '备注': '未找到前缀表',
        '匹配时间': nowStr(),
      }, identity);
      await sleep(800);
      continue;
    }

    // 合格池：仓库相同 且 数量>=10
    const pool = listAllRecords(table.id, identity)
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
    const qtyDelta = new Map(); // record_id -> 扣减量
    const alive = pool.filter(() => true);

    for (let i = 0; i < n; i++) {
      if (alive.length === 0) break;
      const idx = Math.floor(Math.random() * alive.length);
      const picked = alive[idx];
      drawLog.push(picked.sku);
      picked.qty -= 1;
      qtyDelta.set(picked.record_id, (qtyDelta.get(picked.record_id) || 0) + 1);
      if (picked.qty < FLOOR) alive.splice(idx, 1);
    }

    const short = n - drawLog.length;

    // 写回前缀表数量
    for (const [recordId, delta] of qtyDelta) {
      const p = pool.find((x) => x.record_id === recordId);
      await upsert(table.id, recordId, { '数量': p.qty }, identity);
      summary.updatedSkuRows += 1;
      await sleep(800);
    }

    // 写回匹配表
    if (short === 0) {
      summary.matched.push(`${label} → ${compact(drawLog)}`);
      await upsert(matchTable.id, row.record_id, {
        '实际发货SKU': compact(drawLog),
        '状态': '已匹配',
        '备注': '',
        '匹配时间': nowStr(),
      }, identity);
    } else {
      summary.short.push(`${label} → ${drawLog.length ? compact(drawLog) : '无'}（缺${short}个）`);
      await upsert(matchTable.id, row.record_id, {
        '实际发货SKU': drawLog.length ? compact(drawLog) : '',
        '状态': '缺货',
        '备注': `缺${short}个`,
        '匹配时间': nowStr(),
      }, identity);
    }
    await sleep(800);
  }

  return summary;
}

// 摘要 → 回复文本
function formatSummary(s) {
  if (s.none) return '没有待匹配的行（状态为空的才算待匹配）。把随机款SKU粘贴到「匹配表」后发「匹配」即可。';
  const lines = [`✅ 匹配完成，共处理 ${s.matched.length + s.short.length + s.failed.length} 行：`];
  if (s.matched.length) {
    lines.push(`\n【已匹配 ${s.matched.length}】`);
    lines.push(...s.matched.map((x) => '· ' + x));
  }
  if (s.short.length) {
    lines.push(`\n【缺货 ${s.short.length}】`);
    lines.push(...s.short.map((x) => '· ' + x));
  }
  if (s.failed.length) {
    lines.push(`\n【失败 ${s.failed.length}】`);
    lines.push(...s.failed.map((x) => '· ' + x));
  }
  lines.push(`\n（子表数量已扣减 ${s.updatedSkuRows} 行，请以多维表格为准）`);
  return lines.join('\n');
}

module.exports = { runMatch, formatSummary };

// 直接运行：node match.js
if (require.main === module) {
  runMatch()
    .then((summary) => {
      console.log(JSON.stringify(summary));
    })
    .catch((err) => {
      console.error('匹配失败:', err.message);
      process.exit(1);
    });
}
