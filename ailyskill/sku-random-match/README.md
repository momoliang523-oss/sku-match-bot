# sku-random-match — 随机款SKU匹配技能（Aily）

## 这个技能做什么

把多维表格「订单详情表」里待匹配的随机款SKU（如 `twh-2p-xxx`，Np=抽N次），按前缀找同名前缀表、按仓库筛选、随机抽取实际发货SKU，扣减前缀表数量并写回结果（已匹配/缺货/失败）。

多维表格里只有两类表：**订单详情表**（含「随机款SKU」字段，自动识别）+ **前缀表们**（手动添加，表名=前缀，如 `twh`、`RS1`；库存数量随时可改）。

## 目录结构

```
sku-random-match/
├── SKILL.md            # 技能定义（Aily 读取）
├── README.md           # 本文件
├── config.example.json # 配置模板
├── references/rules.md # 完整业务规则
└── scripts/match.js    # 核心脚本（零依赖，Node ≥ 18）
```

## 发布到 Aily 技能市场（发布者操作）

1. 打开 https://aily.feishu.cn/ai/skills （飞书智能伙伴 → 技能）。
2. 上传本技能文件夹或打包的 zip（把 `config.example.json` 复制为 `config.json` 并填好你的凭据 **只在你自用安装时**；公开发布请保持无真实密钥）。
3. 编辑 SKILL.md 或按界面引导完善信息，发布时可见范围选「企业可见」（同事可搜到）或按需调整。
4. 发布后进入质量评估与安全扫描；企业管理员可能需要审核（见下方「管理员配置」）。

## 同事安装后怎么用

1. 同事在 Aily 技能商店搜「随机款」或技能名，一键安装到工作助手/Agent。
2. 同事需在自己的环境配好凭据（见「配置」），并确认目标多维表格结构与规则一致。
3. 对话里直接说「帮我匹配随机款SKU」或 `/sku-random-match` 唤起，技能会运行脚本并回复结果。

## 配置

优先级：命令行参数 > 环境变量 > config.json。

| 项 | 环境变量 | config.json | 说明 |
|----|----------|-------------|------|
| 应用ID | FEISHU_APP_ID | appId | 飞书自建应用（企业内） |
| 应用密钥 | FEISHU_APP_SECRET | appSecret | 同上 |
| 多维表格token | BASE_TOKEN | baseToken | Base 链接 /base/ 后的字符串 |
| 订单表名（可选） | FEISHU_ORDER_TABLE | orderTable | 不填则自动识别含「随机款SKU」字段的表 |

### 应用侧准备（一次性）

1. 飞书开发者后台，应用需开通权限：`base:table:read`、`base:record:read`、`base:record:update`。
2. 在目标多维表格「分享 → 添加协作者」里把该应用加为**可编辑**。
3. 多维表格需包含「订单详情表」（含随机款SKU字段）和以SKU前缀命名的前缀表，字段与 [references/rules.md](references/rules.md) 一致。

## 本地测试

```bash
cd sku-random-match
cp config.example.json config.json   # 填入真实凭据
node scripts/match.js                # 执行匹配
node scripts/match.js --dry-run      # 预览不写入
```

## 安全注意

- `config.json` 含密钥，**不要提交/公开**；公开发布技能包时包里不要带真实密钥。
- 企业内使用建议让每位使用者用自己的应用凭据，或由管理员统一发放。
- 脚本只做：读取匹配表、随机抽取、写回结果与数量扣减；不会删除数据。
