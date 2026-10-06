# 开发者工具自带skill与诊断接口

首次使用或当前工具版本变化时，先定位当前安装自带的wechatide-skill，读取SKILL.md、references/tool-index.md和本次操作对应的子skill。不能只读取wx-check，不能把未找到命令直接说成没有接口。官方包说明工具怎么调用，wx-check规定测什么、顺序及交付；用户明确要求优先，已有授权身份和wx-check的有限等待规则保持不变。

## 定位与读取

从实际开发者工具安装目录定位Resources/app.asar.unpacked/wechatide-skill；macOS示例为应用Contents/Resources下，Windows从实际安装目录resources下查找。大小写和路径以本机文件为准，不把示例路径当要求。找不到时只读搜索安装目录中的SKILL.md及tool-index.md，并报告定位结果。

必读：根SKILL.md、references/environment-readiness.md、references/tool-index.md。按阶段读取：登录/开窗/AppID用skills/initializer/SKILL.md；导入/项目列表用skills/project-manager/SKILL.md；编译用skills/compiler/SKILL.md；诊断用skills/debugger/SKILL.md；点击/输入用skills/automator/SKILL.md；云服务用skills/cloudbase-operator/SKILL.md。参数不清楚时查对应命令--help或注册表wechatide-tools/references/tools.yaml的单项，不猜参数或工具名。

## 已登记的代码诊断接口

本机官方skill 0.3.11登记以下接口，其他版本仍以本机索引和帮助为准：

| 证据 | 工具 | 使用方式/边界 |
| --- | --- | --- |
| 登录及版本 | check_wechatide_status | 按根skill版本检查，沿用已授权clientName |
| WXML/WXSS编译 | compile_wxml / compile_wxss | 按compiler参数，不能替代JS和整包构建 |
| 运行日志 | get_simulator_console | command用grep -n .取全部记录，再分析error/warning；不要只取error遗漏警告 |
| 网络 | get_simulator_network | command用grep -n .；空结果不直接证明没有失败请求 |
| 当前运行状态 | automation_runtime_info | 只读上下文，不代替开窗 |
| 模拟器截图 | simulator_screenshot | 这是小程序模拟器截图，不是整个IDE诊断面板截图 |
| npm构建 | build_npm | 会写产物，取得对应授权后执行，不当作只读面板查询 |

例如（目标工程已确认、窗口可用）：

```bash
wechatide -c <已授权clientName> get_simulator_console --project <工程绝对路径> --command "grep -n ."
wechatide -c <已授权clientName> get_simulator_network --project <工程绝对路径> --command "grep -n ."
wechatide -c <已授权clientName> automation_runtime_info --project <工程绝对路径>
```

## IDE面板与接口不能混为一谈

本机0.3.11的tool-index及tools.yaml中未找到构建、问题、输出、代码质量四个IDE面板各自的专用读取命令；这是该版本登记接口的范围，不是“开发者工具没有诊断接口”。上述接口有诊断证据但不等于面板全部内容。不得编造代码质量命令，也不得拿console日志替代代码质量扫描。

逐项记录已查的官方索引版本、相关工具、实际返回与仍缺的证据。存在已授权、已验证的其他只读工具内部通道时可补充，并标明非官方CLI、版本限制及实测依据；不能假称历史上所有面板都已由CLI查完。

缺面板专用接口时，先尝试当前允许的窗口可访问性读取（AX/UIA）并切换具体面板，再考虑截图。截图权限失败不意味着可访问性或已有调试通道也失败，须分别检查。屏幕权限阻塞时明确具体权限及原因，请用户选择授权或手动在IDE中查看并提供结果；不得绕过权限。模拟器截图不需要被误当成整个IDE截图。只有补查仍无法完成时记录该面板未覆盖，不能写没问题。

## 已验证的面板读取方式（2026-10-07，Mac）

本轮通过窗口可访问性读取当前booking-miniprogram工程，无需截图、未重启或改业务数据：读取调试器Errors:0/Warnings:5以及五条警告正文；切换代码质量面板读取扫描时间2026/10/06 22:00、“未发现代码质量问题”及主包、代码压缩、代码包、无使用或无依赖文件、敏感信息类别；切换问题面板读取“目前尚未在工作区检测到问题”。这些是当前可见结果，代码质量为历史扫描，不能冒充本轮重扫。

构建面板可切换，日志徽标100，但正文以终端图像呈现，本轮未读全；输出可读取选中Extension Host通道，但正文编辑器提示暂不可访问，本轮未读全。需要继续尝试编辑器可访问性、允许的截图或已授权并验证的内部通道，不能根据徽标或空正文判没问题。这次证明部分面板数据能读，不证明所有面板完整检测完成。Windows UIA及WorkBuddy自身读取能力尚未在本轮验证。

## 已验证的脚本读取（2026-10-07）

经用户授权重启一次开启本机9223调试端口后，已用脚本调用当前Stable 2.02.2608080的内部服务，在booking-miniprogram读到代码质量13项完整结果（包含success、text、detail等字段），以及构建消息队列88条正文。不是官方CLI注册命令，但实际接口读取成功，不依赖截图。

入口：`node scripts/read-ide-diagnostics.mjs --project <已确认工程绝对路径> --out <工程外诊断JSON>`。已有调试端口直接复用；未开时按授权流程开启，不自动重启。默认从当前工具窗口地址定位安装模块目录，必要时用WECHATIDE_MODULES_DIR覆盖。运行时按模块导出的能力发现状态、服务入口、构建和代码质量服务，不硬编码版本号或模块哈希。先核验方法及结果结构；缺失或歧义时明确报告接口变化，转官方接口、可访问性或原始日志补查，不假称无诊断。Windows实际调用尚未在本轮验证。

构建队列只保留尚未被面板消费的记录；面板已加载后队列可能为空，不能当全部历史，也不能把空队列当无日志。此时须继续读取面板终端缓冲或实际截图。代码质量服务读取/计算当前编译分析结果，不改业务源码；保留采集时间，不混同旧界面扫描时间。

输出面板已验证可通过“打开活动日志输出文件”定位原始日志，并与可见正文时间及内容匹配后读取。本轮匹配Extension Host日志96行，包含1条error；不能只根据编辑器“暂不可访问”提示判数据无法读取。其他输出通道须分别选取并核对实际文件，不能把扩展宿主日志代表所有输出。问题面板可访问性读取仍可用；此脚本不假称已采集这两项。

### 升级适配要求

版本号仅作为证据记录，不作为拒绝执行条件。每次从当前安装发现模块，不沿用旧版本模块名。已实测当前窗口动态发现，模拟全部模块文件改名后仍定位成功；这是模块重命名兼容验证，不是未来所有版本保证。内部接口结构变化仍可能需要适配，执行者必须保存具体差异并尝试其他已验证读取通道，不能泛称升级后无法检测。
