# 开发者工具自带skill与诊断接口

首次使用或当前工具版本变化时，先定位当前安装自带的wechatide-skill，读取SKILL.md、references/tool-index.md和本次操作对应的子skill。不能只读取wx-check，不能把未找到命令直接说成没有接口。官方包说明工具怎么调用，wx-check规定测什么、顺序及交付；用户明确要求优先，已有授权身份和wx-check的有限等待规则保持不变。

## 定位与读取

从实际开发者工具安装目录定位Resources/app.asar.unpacked/wechatide-skill；macOS示例为应用Contents/Resources下，Windows从实际安装目录resources下查找。大小写和路径以本机文件为准，不把示例路径当要求。找不到时只读搜索安装目录中的SKILL.md及tool-index.md，并报告定位结果。

必读：根SKILL.md、references/environment-readiness.md、references/tool-index.md。按阶段读取：登录/开窗/AppID用skills/initializer/SKILL.md；导入/项目列表用skills/project-manager/SKILL.md；编译用skills/compiler/SKILL.md；诊断用skills/debugger/SKILL.md；点击/输入用skills/automator/SKILL.md。云服务先从源码确认实际SDK和服务来源，微信云开发/CloudBase用skills/cloudbase-operator/SKILL.md，其他服务查其对应接口，不一律按wx.cloud处理。参数不清楚时查对应命令--help或注册表wechatide-tools/references/tools.yaml的单项，不猜参数或工具名。

## 已登记的代码诊断接口

以下是接口用途；可用名称、参数与返回结构以当前安装的索引和帮助为准：

| 证据 | 工具 | 使用方式/边界 |
| --- | --- | --- |
| 登录及版本 | check_wechatide_status | 按根skill版本检查，沿用已授权clientName |
| WXML/WXSS编译 | compile_wxml / compile_wxss | 按compiler参数，不能替代JS和整包构建 |
| 运行日志 | get_simulator_console | command用grep -n .取全部记录，再分析error/warning；不要只取error遗漏警告 |
| 网络 | get_simulator_network | command用grep -n .；空结果不直接证明没有失败请求 |
| 当前运行状态 | automation_runtime_info | 只读上下文，不代替开窗 |
| 元素点击与输入 | automation_element_action | --selector定位具体目标，--action tap/input；输入用--value并读回核对 |
| wx接口调用／模拟／还原 | automation_wx_api | --action call/mock/restore，--method为API名；模拟用--result或--result-file，使用后restore并核对 |
| 模拟器截图 | simulator_screenshot | 这是小程序模拟器截图，不是整个IDE诊断面板截图 |
| npm构建 | build_npm | 会写产物，取得对应授权后执行，不当作只读面板查询 |

例如（目标工程已确认、窗口可用）：

```bash
wechatide -c <已授权clientName> get_simulator_console --project <工程绝对路径> --command "grep -n ."
wechatide -c <已授权clientName> get_simulator_network --project <工程绝对路径> --command "grep -n ."
wechatide -c <已授权clientName> automation_runtime_info --project <工程绝对路径> --action currentPage
wechatide -c <已授权clientName> compile_wxml --project <工程绝对路径> --file-path <相对miniprogramRoot的WXML路径>
wechatide -c <已授权clientName> compile_wxss --project <工程绝对路径> --file-path <相对miniprogramRoot的WXSS路径>
```

编译接口读取的是编译产物摘要，不能把指定文件入口或返回success直接当整页预览、整包构建通过。原生弹窗的业务确认／取消分支可在授权范围内用官方mock配合真实按钮触发核验，不能用直接调用处理函数代替点击；模拟结果与原生界面实际观察分开报告。

## IDE面板与接口不能混为一谈

已有索引中未找到构建、问题、输出、代码质量四个IDE面板各自的专用读取命令；这是所查索引的范围，不是“开发者工具没有诊断接口”。上述接口有诊断证据但不等于面板全部内容。不得编造代码质量命令，也不得拿console日志替代代码质量扫描。

逐项记录已查的官方索引版本、相关工具、实际返回与仍缺的证据。存在已授权、已验证的其他只读工具内部通道时可补充，并标明非官方CLI、版本限制及实测依据；不能假称历史上所有面板都已由CLI查完。

问题与输出优先使用下方内部服务读取，不能把无障碍当必备条件。内部服务能力缺失时才尝试当前获准的AX/UIA或截图，分别记录权限与结果。System Events的-10004仅说明该调用被拒绝，不直接证明所有无障碍、截图或已有调试通道不可用；不重试同一被拒绝命令，不绕过系统权限。全部可用读取方式仍失败时明确未覆盖及下一步，不能说没问题。

## 内部诊断读取

```sh
node scripts/read-ide-diagnostics.mjs --project <已确认工程绝对路径> --out <工程外诊断JSON> --port <实际端口>
```

已有通道直接复用，未开时按[调试通道](debug-channel.md)准备。读取器不调用CLI登录、不打开工程、不刷新、不重启。默认从目标窗口地址发现当前安装模块目录，必要时设置WECHATIDE_MODULES_DIR；按导出能力发现状态、服务入口、构建和代码质量服务，不硬编码版本或模块哈希。方法或结构缺失／歧义时保存实际错误，选择可用接口、原始日志或已获准的界面读取补查。

构建队列只含尚未被面板消费的记录，空队列不等于无构建错误；需补读面板缓冲或获准的截图。代码质量服务计算当前编译分析结果，记录采集时间和返回字段，不混同旧扫描结果。内部接口属于工具实现，升级后重新核验能力，不承诺所有未来版本，也不按版本号拒绝检测。

## 当前问题与输出读取

read-ide-diagnostics.mjs按导出能力发现IEditorWorkbenchService，从已初始化的workbench通过invokeFunction访问markerService与outputService，不硬编码模块哈希或版本。问题列表保留文件、位置、严重程度和来源，工程外消息不算工程缺陷；列表为空只证明当前快照为空，不保证所有未打开文件完成分析。

输出枚举当前窗口真实登记通道，优先读已加载文本模型；未加载时仅读取描述符绑定的本地文件，不遍历缓存目录猜日志。保留通道名、扩展归属、策略、偏移及正文；偏移未知、超过2MiB截断或某通道失败均标部分覆盖/未覆盖。关键字匹配只作线索，不自动认作工程错误。

默认liteMode不初始化编辑器。代码测试应在首次开窗时指定--window-mode fullMode，再核对实际编辑器状态；现有业务测试先收尾，不能中途切换破坏页面实例。读取器不自行初始化编辑器、重启或切面板。open返回reuse时不会把旧简洁窗口转换为完整模式，须核对实际窗口与编辑器就绪状态。
