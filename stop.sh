#!/bin/bash
# 停止并卸载开机自启服务
PLIST_TARGET="$HOME/Library/LaunchAgents/com.skumatch.bot.plist"

launchctl unload "$PLIST_TARGET" 2>/dev/null && echo "✅ 已停止并卸载 com.skumatch.bot" || echo "ℹ️ 服务未在运行"
