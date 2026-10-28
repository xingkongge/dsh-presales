# 数字售前 · 商机与报价插件（`@cnbm/dsh-presales` v0.5.0）

数据全部在 WPS 多维表，插件只做：产品检索 → 计价校验 → 报价落库 → Markdown 出单。

v0.2 起带 **Web 面板**，v0.6 起面板含 **报价 / 商机** 两个 tab（商机列表、详情、阶段推进、跟进、报价与产物反查、看板摘要）；v0.3 起支持 **Excel 出单**（保存报价时自动生成，面板可打开/下载）：侧栏「数字售前」→ 报价工作台（选客户/商机、搜产品、改数量折扣、实时合计、一键生成报价单）。

## 工具

| 工具 | 作用 |
|---|---|
| `opp_list` / `opp_get` / `opp_create` / `opp_update` / `opp_stage` / `opp_followup` / `opp_board` | 商机列表/详情/新建/更新/阶段推进/跟进记录/看板 |
| `quote_status` | 环境自检：CLI/登录/scope/10 张表连通性 |
| `quote_catalog_search` | 按关键字/分类查产品（只在售、价格有效） |
| `quote_build` | 计价 + 校验（停产/过期/底价/数量），返回 DTO、违规项、建议模板 |
| `quote_save` | 落库：报价单号、报价单 + V1 + 明细（快照），幂等 |
| `quote_list` | 最近报价单及版本 |
| `quote_render_markdown` | 生成 Markdown 报价单到 `out/quotes/` |
| `quote_render_xlsx` | 在 WPS `报价管理/报价单/` 生成 Excel 报价单（版式：标题/抬头/分节/明细/合计/页脚） |
| `quote_revise` | 基于已有报价生成 V2/V3：改价/改量/增删，自动写变更说明并重出 Excel |

## 配置

```yaml
- id: presales
  name: '@cnbm/dsh-presales'
  config:
    write: true
    showCost: true
    defaultTaxRate: 0.13
    minMarginWarn: 0.15
    outputDir: ''          # 留空 = ~/.dsh/presales-out/quotes
    tables: {}             # 覆盖默认表别名
```

表别名默认指向 `AI事业部知识库/售前数字员工` 下的 6 个库（见 `lib/tables.js`）。

## 模块拆行与版本

- 产品带模块时，默认勾选模块自动拆行（`模块单价不含税` 单独计价）；`quote_build` 可用 `modules:[...]` 显式选择；
- `quote_revise` 生成新版本：按产品+名称对比旧版，输出「数量/折扣/单价 变化 + 新增/移除」，写入 `报价版本.变更说明`；
- 出单后登记 `文档产物`（产物编号 `<单号>-<版本>-XLSX`、类型报价单、状态已生成、溯源链接）。

## 计价口径

- 产品标准价/成本价 = **不含税**；
- 不含税单价 = ROUND(标准价 × 折扣, 4)，小计 = ROUND(单价 × 数量, 2)；
- 税额 = ROUND(小计 × 税率, 2)，含税小计 = 小计 + 税额；
- 毛利 = 不含税合计 − 成本合计；毛利率 = 毛利 ÷ 不含税合计；
- 拦截：停产/在研、价格过期、折扣低于最低折扣、数量 ≤ 0、折扣越界；
- 警告：缺成本价、毛利率低于阈值。

## 面板

- 侧栏图标 + 中央面板，数据走同源 `/presales/api/*`（自定义头 `x-dsh-presales`，仅回环地址）；
- 面板接口：`status / customers / opportunities / products / templates / quotes / save`；
- 改 `client.js` 或 `package.json` 的 `dsh.client` 后需要**完全重启应用**才会加载新面板；
- 路由用 `ctx.inject(['webServer'], …)` 延迟挂载（webServer 可能晚于插件激活，直接 `ctx.get` 会拿到 undefined → 面板 404）。

## 安装

```bash
dsh plugin --profile desktop add /Users/liangli/Documents/deepseek-harness/default-workspace/wps-presales-plugin
```

改源码需完全重启应用。测试：`node --test test/`。


## 面板更新（v0.7+）

报价 tab 底部「插件更新」卡片：

- 「检查更新」→ GitHub Releases latest（公开仓库，无需 token）；
- 有新版 → 显示本地/最新版本 + 「更新」按钮；
- 「更新」→ Host 下载 tgz 并执行 `dsh plugin --profile <profile> add <tgz>`；
- 完成后需**完全重启 DSH**。

仓库：`xingkongge/dsh-cnbm-wps365`、`xingkongge/dsh-presales`（public）。


## 面板 tab 与「新建商机（对话）」

- tab 顺序：**商机 → 报价**，默认打开商机；
- 商机 tab 右上「新建商机（对话）」：调用客户端 `uiWorkspace.startSession` 打开新会话，并把数字售前的新建商机提示词预填到输入框；
- 提示词包含客户/名称/金额/阶段/落单时间/联系人/行业/简介的填写说明，发送后 Agent 会先 `opp_list` 查重再 `opp_create`。


## 内置技能 `digital-presales`

插件启动时会用 `ctx.skills.register` 注册技能 **digital-presales**（runtime provider）：

- 商机 11 阶段、新建流程（只校验连接、不比对样例、自然语言引导）；
- 报价口径、模块拆行、拦截规则、V2、文档产物登记；
- WPS 联动与授权边界。

内容维护在 `lib/skill.js`（改完发版即可，所有会话自动可见）。


## v0.8.1

- 面板「新建商机（对话）」提示词改为由 `lib/skill.js` 的 `NEW_OPP_PROMPT` 统一提供（面板通过 `/presales/api/skill_prompt` 拉取），技能内容与按钮不再两处维护。
- 复杂解决方案模板按《信云智联·AI产品线报价管理系统》样例重建（11 列 + 每节小计 + 版本/审核状态/交付周期）。


## v0.9.1 · 本地一次性模板

- 报价 tab 新增「选择本地模板（一次性）」：选一个本地 xlsx，只在本机临时保存（`~/.dsh/presales-local-templates/`），**不写入 报价模板.dbt**；
- 生成报价时复制该模板、按 `{{...}}` 占位符填充，输出到 `~/.dsh/presales-out/quotes/`，面板提供下载链接；
- 明细占位：一行中只要有 `{{序号}}` 或 `{{产品名称}}` 即算一个明细槽位，多行就复制多行占位行；
- 不选本地模板时仍使用知识库内置/已登记的模板。
