#!/usr/bin/env node
/**
 * 随机款SKU匹配机器人
 *
 * 常驻监听飞书消息事件（长连接），收到文本含「匹配」→ 执行匹配 → 回复摘要。
 * 由 launchd 守护（com.skumatch.bot.plist）或手动 node bot.js 启动。
 */

const { spawn, execFileSync } = require('child_process');
const readline = require('readline');
const path = require('path');
const { runMatch, formatSummary } = require(path.join(__dirname, 'match.js'));

const HELP_TEXT = [
  '随机款SKU匹配机器人用法：',
  '· 发「匹配」→ 扫描匹配表中待匹配的行，随机抽取实际SKU并写回',
  '· 发「帮助」→ 显示本说明',
  '',
  '规则：',
  '· 随机款SKU里的 Np 表示抽几次（twh-2p-xxx 抽2次，无 Np 默认1次）',
  '· 按SKU前缀找同名子表（最长前缀优先），按仓库筛选，数量<10的跳过',
  '· 抽不满 → 状态标「缺货」；找不到前缀表 → 状态标「失败」',
].join('\n');

function log(msg) {
  console.error(`[bot ${new Date().toISOString()}] ${msg}`);
}

function sendText(chatId, text) {
  return execFileSync(
    'lark-cli',
    ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--text', text],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
}

// 串行处理消息，避免并发匹配
let inFlight = false;
const pending = [];

async function handleCommand(chatId, content) {
  const text = String(content || '').trim();
  if (text.includes('帮助') || text.toLowerCase().includes('help')) {
    sendText(chatId, HELP_TEXT);
    return;
  }
  if (!text.includes('匹配')) return; // 无关消息忽略

  sendText(chatId, '收到，开始匹配，请稍候…');
  try {
    const summary = await runMatch('bot');
    sendText(chatId, formatSummary(summary));
  } catch (err) {
    log('匹配出错: ' + err.message);
    sendText(chatId, '❌ 匹配出错：' + err.message);
  }
}

async function pump() {
  if (inFlight || pending.length === 0) return;
  inFlight = true;
  try {
    while (pending.length > 0) {
      const ev = pending.shift();
      await handleCommand(ev.chat_id, ev.content);
    }
  } finally {
    inFlight = false;
  }
}

function main() {
  const child = spawn(
    'lark-cli',
    ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  // stdin 保持打开（event consume 收到 stdin EOF 会退出）
  child.stdin.on('error', () => {});

  child.stderr.on('data', (d) => log('lark-cli: ' + String(d).trim()));

  child.on('exit', (code, signal) => {
    log(`event consume 退出 code=${code} signal=${signal}`);
    process.exit(code === 0 ? 0 : 1);
  });
  child.on('error', (err) => {
    log('启动 lark-cli 失败: ' + err.message);
    process.exit(1);
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      log('无法解析事件行: ' + line.slice(0, 200));
      return;
    }
    // 只处理文本消息
    if (ev.message_type !== 'text') return;
    pending.push(ev);
    pump();
  });
}

main();
