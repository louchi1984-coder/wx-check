# 本机调试通道：如何开启和调用

9223是本skill默认选择的CDP端口，不是微信固定的测试端口，也不是每个工程一个端口。同一个开发者工具主进程的工程窗口共用通道，按工程绝对路径选择目标。官方wechatide登录、编译和常规自动化使用另一条通道，CLI可用不代表9223已开启。9420常用于自动化SDK连接，不是CDP端口的替换值；本skill已有官方自动化接口，不额外启动9420。

CDP需要真实开发者工具主程序在启动时带上`--remote-debugging-address=127.0.0.1 --remote-debugging-port=<实际端口>`。普通图标或CLI自动拉起的实例可能没有这些参数；给已运行实例再发启动命令不能补参数。关闭工具后普通启动也不会保留端口。内部代码诊断和运行中批量切机型前，按下面顺序准备；不要等到UI测试才检查。

这里仅处理通道，不决定检测范围。失败后回到当前测试的“工具调用与核验”：继续本项不依赖CDP的检查，补查受影响来源；仍缺证据时交付部分完成报告。不能把“常规CLI可用”理解成内部诊断或多机型检查已完成。

## 1. 检查已有通道

命令中的路径由执行者替换为本机发现的实际绝对路径，不要求当前目录是skill目录：

```sh
node "<skill绝对目录>/scripts/prepare-debug-channel.mjs" --project "<工程绝对路径>" --port <实际端口>
```

默认端口用9223；显式参数优先于WECHATIDE_DEBUG_PORT，再取默认值。该命令只读：HTTP检查最多3秒；匹配工程后，WebSocket连接和只读Runtime.evaluate各最多3秒。不打开或退出工具。先检查现有连接，通过后无需查询进程。

| 返回 | 接下来做什么 |
| --- | --- |
| ready | 通道和工程窗口均可用，直接进入第3步。工程路径及实际协议均通过时复用，不再调用ps |
| protocol-unavailable | HTTP目标列表可读，但实际协议命令失败或返回工程不符；保留具体错误，核对窗口，不能因此重启或改端口 |
| project-unresolved | 通道已开启，工程窗口未唯一匹配；核对路径，用当前官方CLI打开目标工程后再次只读检查，不重启 |
| authorization-required | 确认未监听、主进程无调试参数；取得本次正常启动／重启许可后执行第2步，多等不会开启端口 |
| inspection-required | 查看原始结果；进程使用其他调试端口时统一实际端口，不为了改成9223重启 |
| execution-blocked | 进程查询或本机访问被拒绝。通过所在agent真正获准的系统执行通道重跑这个只读命令；尚未核对进程时不能退出或启动 |

Mac用ps、Windows用Get-CimInstance核对真实主进程；EPERM、operation not permitted或查询失败不代表进程不存在。使用当前工具的权限申请流程，申请字段本身不证明权限已生效。工具没有获准的执行通道时，交给用户一条填好实际路径的命令，在系统终端运行；不要把仍受限的命令反复重跑，也不要换工具绕过限制。

## 2. 授权后准备一次

先说明会正常退出工具一次，保存未保存工作，取得明确许可；沿用尚未用掉的本次许可，不重复询问。许可不包含强杀、清登录、重装或反复重启。

发现真实主程序入口和当前官方wechatide CLI：Mac核对CFBundleExecutable，Windows核对实际安装。CLI须支持`wechatide -c <clientName> quit`，可用`quit --help`只读核对；不要将旧版`Contents/MacOS/cli`与当前wechatide混用。各平台按实际安装重新发现，不固定作者路径或版本。

由执行者在已获准核对进程并启动桌面程序的执行环境运行以下命令，日志父目录须已存在，日志文件须是新文件：

```sh
node "<skill绝对目录>/scripts/prepare-debug-channel.mjs" --project "<工程绝对路径>" --port <实际端口> --restart-authorized --executable "<真实主程序绝对路径>" --cli "<当前官方wechatide绝对路径>" --log "<工程外新日志绝对路径>"
```

执行者不提前自行quit。准备脚本复查已有通道与进程：已开启则复用；查询受限则在退出前停止；其他端口或多实例则停止核对。条件明确时正常退出一次，最多15秒确认退出，再由启动器传入上述CDP参数启动一次，最多30秒检查真实HTTP目标列表，并对匹配的工程发出只读协议命令。未确认退出不强杀，已启动但失败不自动第二次启动。

启动器仅从GUI子进程环境移除ELECTRON_RUN_AS_NODE，保留NODE_OPTIONS、NODE_REPL_EXTERNAL_MODULE及安全变量，使用detached与unref。不要改用open -a --args、nohup、清锁或删除安全变量。低层launch-debug-channel.mjs只供准备入口调用，launched-unverified不代表通道就绪。

## 3. 验证并使用

```sh
node "<skill绝对目录>/scripts/check-debug-channel.mjs" --project "<工程绝对路径>" --port <实际端口> --out "<工程外新连接信息JSON路径>"
node "<skill绝对目录>/scripts/read-ide-diagnostics.mjs" --project "<工程绝对路径>" --port <实际端口> --out "<工程外诊断JSON绝对路径>"
```

检查返回ready、projectMatches为1且protocol.available为true后再读诊断。--out将工程、端口、CLI路径和clientName保存到新文件，父目录须存在，不覆盖旧记录、不包含连接令牌。CLI字段记录当前配置，不证明CLI已授权，仍须沿用此前核实的身份。

开始后续测试、恢复长任务或连接报错时，先读取本轮连接信息，恢复同一工程、WECHATIDE_DEBUG_PORT、WECHATIDE_BIN及WECHATIDE_CLIENT。记录帮助找回参数，不能证明现在仍连接；需要CDP的测试用check-debug-channel只读复查实际协议，常规点击与流程操作用automation_runtime_info确认当前页。正常操作复用已开的工程；同一批UI采集复用一个WebSocket，诊断读取也在一个连接内完成。不同命令各自连接，不增加常驻进程，也不因上下文变短重新启动工具。UI采集复用相同端口，参数名是`--debug-port`；也可统一设置WECHATIDE_DEBUG_PORT。通道开启后不再调用启动器。read-ide-diagnostics.mjs不调用CLI登录、不打开工程、不刷新模拟器。

需要独立区分连接故障时，只读请求`http://127.0.0.1:<实际端口>/json/version`和`/json/list`；用Node原生HTTP或curl --noproxy '*'，保留stderr与退出码，完整解析JSON但不向用户暴露目标URL中的内部令牌。不能用head、tail或grep管道把失败退出码变成0，或截断JSON后宣称已核验。

## 故障定位

- 主进程无调试参数且ECONNREFUSED：通道未开启，回到第2步；不是工程换了端口，等待或刷新工程不会开启它。
- 宿主能连、agent不能连：对照同一进程、端口、访问权限和代理环境；保留真实证据，进程查询未核实的字段不补猜。
- bad option：核对GUI子进程是否继承ELECTRON_RUN_AS_NODE。
- SingletonLock权限错误、sandbox initialization failed：桌面程序启动被限制，不等于CDP读取也被限制。停止该启动路径，保留日志，不清锁或绕过权限；已启动过需再次启动时另核对许可。
- quit-failed、startup-failed或exit-unconfirmed：保留error中的退出码、信号、原始输出以及launchLog指向的日志和进程检查结果，不循环重启，也不调用可能拉起普通实例的CLI掩盖失败。
