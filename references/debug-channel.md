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
| execution-blocked | 进程查询或本机访问被拒绝，转到用户终端步骤；不把未核实的进程当成已退出 |

首次开启先由agent使用已有获准的命令执行能力完成。Mac的ps无法执行时用已获准的pgrep，Windows用Get-CimInstance；读取失败不能当成进程不存在。因权限、沙箱或启动错误未能开启时，保留原始错误，直接进入下面的用户终端步骤；不要求用户修改沙箱、安全配置或权限模式，不为了交付终端命令先反复申请权限或尝试同一失败启动。

## 2. 授权后准备一次

先说明会正常退出工具并保存未保存工作。用户已授权当前启动／重启时直接执行，不因脚本返回失败、切换命令工具或恢复上下文而重新要求同一许可；用户明确只允许一次时遵守该次数。强杀、清登录和重装仍按用户实际授权处理。

发现真实主程序入口和当前官方wechatide CLI：Mac核对CFBundleExecutable，Windows核对实际安装。CLI须支持`wechatide -c <clientName> quit`，可用`quit --help`只读核对；不要将旧版`Contents/MacOS/cli`与当前wechatide混用。各平台按实际安装重新发现，不固定作者路径或版本。

由执行者在已获准核对进程并启动桌面程序的执行环境运行以下命令；脚本自动建立日志目录，已有同名日志时使用新文件保留旧证据：

```sh
node "<skill绝对目录>/scripts/prepare-debug-channel.mjs" --project "<工程绝对路径>" --port <实际端口> --restart-authorized --executable "<真实主程序绝对路径>" --cli "<当前官方wechatide绝对路径>" --log "<工程外新日志绝对路径>"
```

执行者不提前自行quit。准备脚本复查已有通道与进程：已开启则复用；查询受限则在退出前停止；其他端口或多实例则停止核对。条件明确时正常退出一次，在本次等待预算内确认退出，再由启动器传入上述CDP参数启动一次，在本次等待预算内检查真实HTTP目标列表，并对匹配的工程发出只读协议命令。未确认退出返回exit-pending，不强杀；仍在启动返回starting，继续只读检查，不重复启动。默认等待预算30秒，可用--wait-ms调整。

Mac默认通过`/usr/bin/open -n -a <实际.app> --args <CDP参数>`正常启动，并分别保存标准输出和错误，不从agent进程直接spawn应用主程序。旧的`--launch-method direct`在Mac上会在退出现有工具之前被拒绝，避免继承调用进程的沙箱和注入环境。Windows仍直接启动实际程序。启动器只移除GUI启动子进程的ELECTRON_RUN_AS_NODE，不修改agent的安全设置或安全变量。application的-n仅在已确认没有旧主进程时使用。启动请求、主进程参数、HTTP和Runtime.evaluate分别核验，open返回0或launched-unverified都不是成功。

Mac沙箱中的open可能被系统忽略调试参数，[Apple说明](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/arguments)了这一行为。主进程已出现但没有调试参数时，脚本立即返回startup-failed，保留该窗口并转用户系统终端，不等30秒、不退回直接启动主程序。已有证据表明当前执行环境受限时，可直接提供下面的终端命令，不再先重试失败路径。

## agent开启失败：用户复制命令执行

说明本次失败原因，然后提供适合用户当前系统的一段可复制命令：Mac用系统终端，Windows用CMD。命令先检查已有通道，必要时正常退出开发者工具并带调试参数启动；先提醒保存未保存工作。由agent填入已发现的Node、skill、工程、主程序、CLI、日志的实际绝对路径及已核实的clientName，正确引用路径，不把下面的占位符直接交给用户，不要求安装新运行时。

能正常打开系统终端时，可将填好的命令写入本轮工程外的Mac `.command`或Windows `.cmd`文件：显示完整命令，等待用户按回车后才执行。Mac用`open -a Terminal "<文件绝对路径>"`打开；打开受限则交付可复制命令。文件不能自动执行退出／启动操作，不模拟用户按回车，不要求修改安全配置。终端窗口只证明命令已准备好，执行后仍由agent验证通道。

Mac模板（正常应用启动）：

```sh
WECHATIDE_CLIENT="<已核实clientName>" "<Node绝对路径>" "<skill绝对目录>/scripts/prepare-debug-channel.mjs" --project "<工程绝对路径>" --port <实际端口> --restart-authorized --executable "<真实主程序绝对路径>" --cli "<当前官方wechatide绝对路径>" --launch-method application --log "<工程外新日志绝对路径>"
```

Windows CMD模板（不是PowerShell语法）：

```bat
set "WECHATIDE_CLIENT=<已核实clientName>"
"<Node绝对路径>" "<skill绝对目录>\scripts\prepare-debug-channel.mjs" --project "<工程绝对路径>" --port <实际端口> --restart-authorized --executable "<真实主程序绝对路径>" --cli "<当前官方wechatide绝对路径>" --log "<工程外新日志绝对路径>"
```

不让用户负责排障或判断是否测试通过。用户执行后，agent按第3步检查真实HTTP与工程协议、打开尚未匹配的工程、保存正确连接身份并继续当前测试。starting仅表示还未就绪，project-unresolved表示需打开指定工程；两者先只读复查，不再发启动命令。命令确实失败时查看完整错误，不宣布成功、不清锁或登录状态。

## 3. 验证并使用

```sh
node "<skill绝对目录>/scripts/check-debug-channel.mjs" --project "<工程绝对路径>" --port <实际端口> --out "<工程外新连接信息JSON路径>"
node "<skill绝对目录>/scripts/read-ide-diagnostics.mjs" --project "<工程绝对路径>" --port <实际端口> --out "<工程外诊断JSON绝对路径>"
```

检查返回ready、projectMatches为1且protocol.available为true后再读诊断。--out将工程、端口、CLI路径和clientName保存到新文件，自动创建父目录，同名记录已有时保存新文件并返回connectionFile，不覆盖旧记录、不包含连接令牌。CLI字段记录当前配置，不证明CLI已授权，仍须沿用此前核实的身份。

开始后续测试、恢复长任务或连接报错时，先读取本轮连接信息，恢复同一工程、WECHATIDE_DEBUG_PORT、WECHATIDE_BIN及WECHATIDE_CLIENT。记录帮助找回参数，不能证明现在仍连接；需要CDP的测试用check-debug-channel只读复查实际协议，常规点击与流程操作用automation_runtime_info确认当前页。正常操作复用已开的工程；同一批UI采集复用一个WebSocket，诊断读取也在一个连接内完成。不同命令各自连接，不增加常驻进程，也不因上下文变短重新启动工具。UI采集复用相同端口，参数名是`--debug-port`；也可统一设置WECHATIDE_DEBUG_PORT。通道开启后不再调用启动器。read-ide-diagnostics.mjs不调用CLI登录、不打开工程、不刷新模拟器。

需要独立区分连接故障时，只读请求`http://127.0.0.1:<实际端口>/json/version`和`/json/list`；用Node原生HTTP或curl --noproxy '*'，保留stderr与退出码，完整解析JSON但不向用户暴露目标URL中的内部令牌。不能用head、tail或grep管道把失败退出码变成0，或截断JSON后宣称已核验。

## 故障定位

- 主进程无调试参数且ECONNREFUSED：通道未开启，回到第2步；不是工程换了端口，等待或刷新工程不会开启它。
- 宿主能连、agent不能连：对照同一进程、端口、访问权限和代理环境；保留真实证据，进程查询未核实的字段不补猜。
- bad option：核对GUI子进程是否继承ELECTRON_RUN_AS_NODE。
- sandbox initialization failed、FATAL或GPU process isn't usable：保留启动日志。致命错误优先于短暂的HTTP／协议成功；沙箱初始化错误出现且工程协议未通过时也不能报就绪，即使主进程还在。只在实际工程协议通过、没有致命错误时保留单条警告并继续。不再次启动、不清锁、不修改安全配置，转用户终端。
- SingletonLock权限错误或宿主安全中心待确认弹窗：保留日志并说明来源，按具体授权处理；批准后只读复查已有进程，不再次启动、不清锁或绕过权限。
- quit-failed、startup-failed、exit-pending或starting：保留error中的退出码、信号、原始输出以及launchLog指向的日志和进程检查结果，不循环重启，也不调用可能拉起普通实例的CLI掩盖失败。
