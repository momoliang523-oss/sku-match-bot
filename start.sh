#!/bin/bash
# 安装并启动开机自启服务（macOS launchd）
# 用法：export BASE_TOKEN=<多维表格token> && ./start.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_TARGET="$HOME/Library/LaunchAgents/com.skumatch.bot.plist"

# 由模板生成 plist：替换路径占位符，再写入 BASE_TOKEN
sed -e "s#/Users/ryomomo/sku-match#$DIR#g" \
    -e "s#/Users/ryomomo#$HOME#g" \
    "$DIR/com.skumatch.bot.plist" > "$PLIST_TARGET"

if [ -n "$BASE_TOKEN" ]; then
  sed -i '' "s/YOUR_BASE_TOKEN/$BASE_TOKEN/" "$PLIST_TARGET"
else
  echo "⚠️  未设置 BASE_TOKEN：请先 export BASE_TOKEN=<多维表格token> 再运行，"
  echo "   或手动编辑 $PLIST_TARGET 填入。"
fi

launchctl unload "$PLIST_TARGET" 2>/dev/null || true
launchctl load "$PLIST_TARGET"
echo "✅ 已安装并启动 com.skumatch.bot（开机自启）"
echo "   日志: $DIR/bot.log"
