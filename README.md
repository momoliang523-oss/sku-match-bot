# 随机款 SKU 匹配机器人

在飞书里发一句「匹配」，机器人扫描多维表格里的随机款 SKU，按前缀找到对应的 SKU 库存子表，按仓库随机抽取实际发货 SKU、扣减数量并写回结果。

> 面向电商发货场景：订单里写的是「随机款」（如 `twh-2p-xxx`），仓库里实际发的是同前缀下的任意实物 SKU。

## 功能

- **飞书长连接监听**：无需公网回调地址，常驻进程接收 `im.message.receive_v1` 事件
- **自然语言触发**：消息里包含「匹配」即执行；「帮助」返回用法
- **自动识别订单表**：按「随机款SKU」字段定位订单详情表，不依赖表名
- **前缀最长匹配**：`twh-1p` 优先于 `twh`，大小写不敏感
- **随机抽取出货**：`-2p-` 表示抽 2 次，无 `Np` 默认 1 次；同仓库、数量 ≥ 10 才进入候选池
- **库存扣减与状态回写**：已匹配 / 缺货 / 失败，缺货备注缺几个
- **幂等**：状态非空的行不会重复匹配
- **串行处理**：多条消息排队执行，避免并发写表冲突
- **可预览**：`--dry-run` 只输出匹配计划，不落库

## 工作流

```
飞书群消息
   │  「匹配」
   ▼
lark-cli event consume (WebSocket 长连接)
   │
   ▼
bot.js ──串行队列──▶ match.js
   │                    │  1. 定位订单详情表
   │                    │  2. 扫描待匹配行
   │                    │  3. 前缀 → 子表 → 仓库 → 随机抽取
   │                    │  4. 扣减库存 + 写回状态
   ▼                    ▼
回复摘要          飞书多维表格 (Base API)
```

## 目录

```
bot.js                飞书事件监听 + 命令路由 + 串行队列
match.js              匹配核心(表定位 / 抽取 / 写回 / 摘要)
start.sh              安装 launchd 开机自启
stop.sh / status.sh   启停与状态
com.skumatch.bot.plist launchd 配置模板
ailyskill/            可安装为 Aily 技能的同款实现(config.example.json 驱动)
```

## 依赖

- Node.js ≥ 18（脚本零第三方依赖，只用内置模块）
- [`lark-cli`](https://www.npmjs.com/package/lark-cli)（飞书官方 CLI，负责鉴权与 Base/IM API）
- 一个飞书自建应用：开通 `im:message`、`base:table:read`、`base:record:read`、`base:record:update`，并被加为目标多维表格的协作者

## 配置

多维表格里准备两类表：

1. **订单详情表**（脚本自动识别）：`随机款SKU | 订单号 | 仓库 | 实际发货SKU | 状态 | 备注 | 匹配时间`
2. **前缀子表**（可多张，表名 = 前缀）：`实际SKU | 仓库 | 数量`

运行前设置目标多维表格 token（二选一）：

```bash
# 环境变量
export BASE_TOKEN=你的多维表格token

# 或命令行覆盖
node match.js --base-token 你的多维表格token
```

`ailyskill/sku-random-match/config.example.json` 是技能版的配置模板，复制为 `config.json` 后填入 `appId` / `appSecret` / `baseToken`。

## 运行

```bash
# 常驻机器人
node bot.js

# 安装为开机自启服务(macOS launchd)
./start.sh

# 手动跑一次匹配
node match.js            # 真实写表
node match.js --dry-run  # 只预览
```

## 匹配规则

| 规则 | 说明 |
|---|---|
| 抽取次数 | SKU 中 `-Np-` 段，如 `twh-2p-xxx` 抽 2 次；无 Np 默认 1 次 |
| 前缀匹配 | 表名能作为 SKU 开头（`表名-` 前缀）中最长的那个，大小写不敏感 |
| 候选池 | 子表里仓库一致且数量 ≥ 10 的行 |
| 扣减 | 每抽中一次数量 -1，降到 10 以下移出池 |
| 抽不满 | 已抽到的照写，状态 = 缺货，备注「缺 X 个」 |
| 找不到前缀表 | 状态 = 失败 |
| 重复处理 | 状态非空的行跳过 |

## License

内部工具，未附开源许可证。
