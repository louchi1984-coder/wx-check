# 辅助工具

只保留重复的工具操作。代码判断、交互定位、表单填写与最终业务结果由执行者结合当前工程和官方接口完成，不依赖旧工程选择器或场景文件。

本文件说明共用配置与辅助脚本参数；实际检查目标、结果核验和失败处理分别看[代码测试](code-testing.md#工具调用与核验)、[点击测试](click-testing.md#工具调用与核验)、[流程测试](flow-testing.md#工具调用与核验)、[UI测试](ui-batch.md#工具调用与核验)。辅助脚本不是完整测试，也不改变各项必查范围。

| 工具 | 用途 | 边界 |
| --- | --- | --- |
| prepare-debug-channel.mjs | 检查实际端口、工程窗口，授权后准备通道 | 按[通道说明](debug-channel.md)，失败不循环重启 |
| check-debug-channel.mjs | 独立只读复查通道 | 不登录、不打开工程 |
| read-ide-diagnostics.mjs | 保存构建、代码质量、问题及输出原始证据 | 按[诊断说明](official-tool-skill.md)核对范围，空队列不证明无问题 |
| ui-check.mjs | 同窗口批量切机型、读取尺寸／矩形、保存截图及恢复 | 按[UI说明](ui-batch.md)；截图仍须读图，几何采集不等于完整UI测试 |
| launch-debug-channel.mjs | 准备入口的底层启动器 | 普通测试不单独调用 |

## 调用前

下文及各参考文件的`node scripts/...`命令从skill目录执行；在其他目录调用时，改用脚本绝对路径。需要能运行ES模块及内置WebSocket的Node运行时（现有CDP工具要求Node 22或更新），先核对当前可用运行时，不把缺少运行时当连接失败。

官方调用统一用`wechatide -c <已授权clientName> <工具名> <参数>`。辅助脚本调用CLI时，沿用同一身份：设置WECHATIDE_CLIENT为已授权名称（默认miniprogram-autocheck），WECHATIDE_BIN为当前官方wechatide路径，不混用旧cli。UI机型目录找不到时设置实际WECHATIDE_DATA_DIR；批量UI在默认macOS安装之外须设置实际WECHATIDE_MODULES_DIR，诊断读取器则会先从窗口地址发现模块目录。环境变量在当前执行进程生效；不同工具调用不一定保留上一条命令的export。

## 参数与结果

| 入口 | 必要参数与结果 |
| --- | --- |
| prepare-debug-channel / check-debug-channel | --project为工程绝对路径，--port为CDP端口；退出0且工程匹配数为1才可读取。授权启动的额外参数按通道说明；不使用--out |
| read-ide-diagnostics | --project、--port、--out；--out是工程外JSON文件。保存成功后检查quality、build.scope、problems.available及output各通道的available/complete/truncated，不能把文件生成当所有来源完整读取 |
| ui-check --plan | --project；不切机型、不截图。未设六款精测时列机型目录，设置后列精测与最小检查计划 |
| ui-check --matrix | --project、--out工程外目录；先设置六款WECHATIDE_PRECISE_MODELS，端口参数用--debug-port。完成后检查failures、unvisited、restoration及每页采集/截图结果 |
| ui-check --devices | --project、具体完整机型名、--out；只采集指定机型，不能代替完整matrix计划。--expected-size只检查当前机型，不负责切换 |

UI工具的report.json、report.md和shots目录是采集附件，单项报告由执行者按报告规范整理。低层launch-debug-channel不作为独立测试入口。

## 调用与判断

CLI输出可能夹带日志；按实际完整JSON检查ok及result.success，退出码0不代表业务成功。返回结构与参数查当前官方帮助，不能沿用旧版本猜测。编译入口可能触发整工程编译，错误归属按实际消息，不按调用文件猜测。

开窗后等到具体运行页再操作，已有正确状态直接继续。空字符串输入曾出现返回成功却未清空，必要时用官方元素input事件并读回验证。点击可能改变hover类，定位失败时读取实际元素属性；使用唯一且明确的目标，不修改应用来迁就测试。

UI采集只提供横向溢出、点击区域及稳定性线索，44×44阈值不是自动修复决定。条件渲染、合法空态与遗漏按实际页面判断。重叠、截断、遮挡和布局感受仍由执行者读图及按疑点操作确认。IDE的automator超时与调用进程超时分开；采集只对前者等待20秒重试一次，不重放业务提交。

报告、截图和必要的数据备份保存在工程外。统一报告见[报告规范](reporting.md)，修复与数据保护分别见[修复](repair.md)、[执行条件](execution.md)。

## 维护检查


以下自检验证通用工具的协议与失败处理，不是小程序项目的检测结果；普通使用不需要先运行它们：

```sh
node scripts/debug-channel-selftest.mjs
node scripts/diagnostics-selftest.mjs
node scripts/device-live-selftest.mjs
node scripts/ui-batch-selftest.mjs
```

测试夹具在临时目录创建，发布包不含业务工程或历史测试数据。工具内部接口升级后按实际能力重新核验；具体工程和开发者工具版本的运行结果须以实测为准。
