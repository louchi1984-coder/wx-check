---
name: wx-check
description: 搭配微信开发者工具，通过 wechatide 对原生微信小程序做代码、UI、点击和流程四类测试，提供可重复验证的问题报告与最小修复。用于小程序体检、报错排查、显示异常、按钮响应检查和用户流程测试。
---

# 小程序测试

搭配微信开发者工具使用。skill 负责测试目标、判据和修复流程；`wechatide` 提供真实编译、模拟器采集、导航、点击和输入。没有工具时仍可做静态工程检查，但不能宣称运行测试通过。

## 四类测试

| 测试项目 | 用户关心的问题 | 脚本能做的 | 脚本做不到、需补测的 |
|---|---|---|---|
| 1 代码测试 | 程序有没有写对 | 配置与资源、WXML/WXSS 真编译、运行报错与请求异常 | 开发者工具各诊断面板、相关终端结果；编译通过不证明业务正确 |
| 2 UI测试 | 界面显示正不正常 | 多机型横向溢出、触控区、文字截断、绑定字段 | 截图逐张读图；审美与全部显示状态 |
| 3 点击测试 | 按钮点了有没有反应 | 实际点击静态可识别的导航入口 | 业务按钮及其他交互 |
| 4 流程测试 | 像真人一样用一遍，看顺不顺 | 表单空提交、填值提交 | 完整任务清单与最终业务结果 |

只用这四个名称，可带编号 1–4，不称“第几层”或“模块A/B”。执行顺序固定：代码 → 点击 → 流程 → UI（UI 最后，测修复后的最终版本）。

## 必须按步骤执行

每轮先确认当前进度，已完成的步骤沿用；缺信息就停在对应步骤，不自行补答案。

| 步骤 | 现在要做什么 | 完成条件 | 还没完成时 |
| --- | --- | --- | --- |
| 1 找工具 | 找到微信开发者工具及CLI，检查连接授权 | 确认对应同一安装且能连接 | 说明缺少什么；需要安装或授权则询问 |
| 2 登录 | 查登录状态，必要时扫码 | CLI确认已登录 | CLI二维码失败就调出真实登录窗口让用户手动扫码；不画二维码、不反复等待 |
| 3 选工程 | 使用已指定工程，否则列项目让用户选 | 确认目标工程路径 | 等待用户选择，不自己选或创建业务工程 |
| 4 AppID | 问有没有AppID；没有则让用户在工具里手动选测试号 | 用户已选，实际配置可核对 | 等待选择，不生成或猜测固定ID |
| 5 打开工程 | 打开或导入工程，核对路径、AppID和编译就绪 | 记录编译与模拟器状态 | 编译失败可进入代码测试；模拟器不可用则暂停依赖运行的检查 |
| 6 选检测 | 问“做代码、点击、流程、UI测试，还是全部？” | 范围明确，必要的数据操作已授权 | 等待答案；只读准备可以继续 |
| 7 做检测 | 只做选定项，按固定顺序 | 每项完成或说明哪些没测成 | 工具故障说明原因，不算通过，不偷偷跳过 |
| 8 给报告 | 每项结束交付报告，全部结束再汇总 | 统一模板，证据可访问 | 缺证据写清楚 |
| 9 修复 | 按已有授权修复并重测，再继续下一项 | 有重测证据 | 未授权只给修复建议 |

用户已明确范围时不再问步骤6。“扫码了”只完成步骤2；“继续”只恢复已确认的步骤和范围，不等于允许全部检测和修复。缺工具、未登录或编译失败时，若用户已选代码测试，可先做静态检查，其余写“未覆盖”。

## 硬规则

1. 没实际执行的不算通过，写“未覆盖”并说明原因。退出码 0、P0 为 0、编译成功、截图存在，都不能单独证明某项完成。
2. 安装、认证、修改 AppID，以及写入／删除／清空／导出用户数据前，先确认授权范围。只操作用户指定的一个工程。
3. 首次执行先按 [official-tool-skill.md](references/official-tool-skill.md) 读取当前安装的官方 skill，不能只凭本 skill 猜命令或直接说“没有接口”。
4. 会产生检测结果的脚本（selfcheck、tap-check、ux-check、ui-check）必须带 `--out <工程外目录>`，脚本会拒绝缺失或位于工程内的目录，并按时间戳独占保存，无需手工另存。工程内 `.mp-autocheck/` 只是最近一次副本，不作证据。`--plan`、各 `*-selftest.mjs`、`report-lint.mjs` 不产生检测证据，不需要 `--out`。
5. 区分实际观测与静态推断：代码里有 `showToast` 不等于提示弹出，页面跳转不等于提交成功。
6. 改工程前备份、只改必要范围、改后重测，重测失败回滚，不覆盖用户后续改动。
7. 对用户说普通话：每份报告先写普通人能懂的结论，技术日志只作附件。

## 到哪一步读什么

| 时机 | 读取 |
|---|---|
| 开始 | [用户引导](references/user-flow.md)、[跨平台验证](references/platform-validation.md)、[官方工具接口](references/official-tool-skill.md) |
| 步骤 1–2 | [登录处理](references/login.md) |
| 步骤 3–6 | [用户引导](references/user-flow.md)、[执行条件与写操作边界](references/execution.md) |
| 代码测试 | [代码测试检查清单](references/code-testing.md) |
| 点击测试 | [点击测试要求](references/click-testing.md) |
| 流程测试 | [完整任务识别与流程测试](references/flow-testing.md) |
| UI测试 | [批量 UI 检测](references/ui-batch.md) |
| 步骤 8（必读） | [检测报告统一规范](references/reporting.md)，写完用 `report-lint.mjs` 校验 |
| 步骤 9 | [两种修复方式](references/repair.md) |
| 排查通道、返回结构 | [工具细节与采集限制](references/tool-details.md) |

## 常用命令

只在步骤 1–6 完成、范围明确后执行，从技能目录运行。`--project` 指向含 `app.json` 的源码目录（不会自动解析外层 `miniprogramRoot`）。加 `--json` 时 stdout 只有 JSON，进度在 stderr。

```bash
# 代码测试：逐项执行，每次生成新的证据文件
node scripts/selfcheck.mjs --project <源码> --out <证据目录> --only config   # 静态，不需要开发者工具
node scripts/selfcheck.mjs --project <源码> --out <证据目录> --only compile
node scripts/selfcheck.mjs --project <源码> --out <证据目录> --only runtime
node scripts/selfcheck.mjs --project <源码> --out <证据目录> --only content
# 开发者工具诊断面板：逐面板给出 已检查/部分覆盖/未覆盖；需本机调试通道（默认 9223，首次开启要用户授权重启一次）
node scripts/selfcheck.mjs --project <源码> --out <证据目录> --only diagnostics [--debug-port 9223]

# 点击测试：独立入口（selfcheck 不接受 --tap）
node scripts/tap-check.mjs --project <源码> --out <证据目录>   # 只点导航入口，业务按钮另行补测

# 流程测试：先满足 execution.md 的执行条件
node scripts/ux-check.mjs --project <源码> --out <证据目录> [--values-file <值文件>]

# UI测试：小中大各两款精测，其余最小检查，结束恢复原机型
node scripts/ui-check.mjs --project <源码> --matrix --out <证据目录>
node scripts/ui-check.mjs --project <源码> --plan        # 只生成计划，不切换
```

指定机型、单尺寸、合并报告等参数见 [ui-batch.md](references/ui-batch.md)。

交付前校验用户报告（步骤 8）：

```bash
node scripts/report-lint.mjs --report <统一报告.md>   # 退出码 1 = 有错误，先补报告再交付
```

## 修改脚本后

以下自检都用隔离数据或模拟连接，不操作开发者工具和被测工程，也不是项目测试报告：

```bash
node scripts/selftest.mjs              # 纯函数
node scripts/device-selftest.mjs       # 机型切换
node scripts/device-live-selftest.mjs  # 运行中切换
node scripts/ui-batch-selftest.mjs     # 批量 UI
node scripts/interaction-selftest.mjs  # 条件按钮、存储恢复、多字段输入
node scripts/evidence-selftest.mjs     # 证据保存与入口参数
node scripts/diagnostics-selftest.mjs  # 诊断面板整理
node scripts/report-lint-selftest.mjs  # 报告校验
node scripts/tap-static-selftest.mjs   # 点击入口静态解析
node scripts/runtime-selftest.mjs      # 登录状态、准备时限、当前页面保护
```
