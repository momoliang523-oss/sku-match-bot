#!/bin/bash
# 查看服务状态
if launchctl list | grep -q com.skumatch.bot; then
  echo "✅ com.skumatch.bot 运行中"
  launchctl list | grep com.skumatch.bot
else
  echo "❌ com.skumatch.bot 未运行"
fi
echo "--- 最近日志 ---"
tail -n 20 ~/sku-match/bot.log 2>/dev/null || echo "(暂无日志)"
