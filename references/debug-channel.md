# 本机调试通道：如何开启和调用

9223是本skill默认选择的CDP端口，不是微信固定的测试端口，也不是每个工程一个端口。同一个开发者工具主进程的工程窗口共用通道，按工程绝对路径选择目标。官方wechatide登录、编译和常规自动化使用另一条通道，CLI可用不代表9223已开启。9420常用于自动化SDK连接，不是CDP端口的替换值；本skill已有官方自动化接口，不额外启动9420。

CDP需要真实开发者工具主程序在启动时带上`--remote-debugging-address=127.0.0.1 --remote-debugging-port=<实际端口>`。普通图标或CLI自动拉起的实例可能没有这些参数；给已运行实例再发启动命令不能补参数。关闭工具后普通启动也不会保留端口。登录与导入前先开启通道，任何测试开始前再验证目标工程协议；不要等到UI测试才检查。

通道是全部测试的前置条件。未开启或断开时暂停所有测试，只处理启动与连接，不调用会自动拉起普通实例的CLI，不以部分报告继续下一项。HTTP通道可连接后仅允许登录、选工程和导入等准备；目标工程协议验证通过后才能测试。普通CLI可用不能替代通道验证。

## 1. 检查已有通道

### 首次启动就带调试参数

在登录状态查询、编译或打开工程等CLI调用之前，先用check-debug-channel.mjs --port <实际端口>只读检查现有HTTP通道；此时不需要工程路径。HTTP不可连接时再核对主进程及本执行环境已有启动证据。发现安装路径只读目录和安装信息，不通过图标、GUI应用控制或普通open来启动工具。已确认当前执行环境的启动参数会被丢弃时，直接进入用户终端步骤；不再次通过该环境启动工具来复现失败，也不先打开普通窗口。没有此类失败证据且工具尚未运行时，使用已有启动器首次带参数打开，不先普通启动再退出重开。此时尚未选定工程也可以启动；工程确定后再核验工程协议。无论选择哪类测试，都先完成通道准备。

```sh
node "<skill绝对目录>/scripts/launch-debug-channel.mjs" --executable "<真实主程序绝对路径>" --port <实际端口> --log "<工程外新日志绝对路径>" --start-authorized
```

由agent填入实际路径并使用本轮已有启动授权。Mac使用默认系统应用启动方式；Windows使用实际主程序。启动器发出请求后，由agent只读检查通道，再进行登录、选工程和导入。已有实例且通道可用时复用；只有已经运行的普通实例没有调试参数时，才需要正常退出后重启。

命令中的路径由执行者替换为本机发现的实际绝对路径，不要求当前目录是skill目录：

```sh
node "<skill绝对目录>/scripts/check-debug-channel.mjs" --port <实际端口>
# 工程确定后才执行以下核验
node "<skill绝对目录>/scripts/check-debug-channel.mjs" --project "<工程绝对路径>" --port <实际端口>
```

未指定工程的ready只表示HTTP可连接，可继续登录和选工程，不代表测试条件齐备。指定工程后必须同时满足ready、projectMatches为1及protocol.available为true才允许测试。DevToolsActivePort文件、端口号、启动请求和旧连接记录都不能替代本次真实检查。

默认端口用9223；显式参数优先于WECHATIDE_DEBUG_PORT，再取默认值。该命令只读：HTTP检查最多3秒；匹配工程后，WebSocket连接和只读Runtime.evaluate各最多3秒。不打开或退出工具。先检查现有连接，通过后无需查询进程。

| 返回 | 接下来做什么 |
| --- | --- |
| ready | 未指定工程时只证明HTTP可连接，继续准备；指定工程且匹配数为1、实际协议通过时才可测试，不再调用ps |
| protocol-unavailable | HTTP目标列表可读，但实际协议命令失败或返回工程不符；保留具体错误，核对窗口，不能因此重启或改端口 |
| project-unresolved或projectMatches不为1 | HTTP通道已开启，但工程未唯一匹配；核对路径，用当前官方CLI打开目标工程后再检查工程协议，不开始测试、不重启 |
| authorization-required | 确认未监听、主进程无调试参数；取得本次正常启动／重启许可后执行第2步，多等不会开启端口 |
| inspection-required | 查看原始结果；其他端口沿用实际值；退出后出现新PID时核对谁重新拉起工具并暂停该调用，不误报旧进程未退出 |
| execution-blocked | 进程查询或本机访问被拒绝，转到用户终端步骤；不把未核实的进程当成已退出 |

能可靠传入参数的执行环境由agent使用已有获准的命令能力启动；已确认会丢参数的环境直接走用户终端步骤。Mac的ps无法执行时用已获准的pgrep，Windows用Get-CimInstance；读取失败不能当成进程不存在。因权限、沙箱或启动错误未能开启时，保留原始错误，直接进入下面的用户终端步骤；不要求用户修改沙箱、安全配置或权限模式，不为了交付终端命令先反复申请权限或尝试同一失败启动。

## 2. 已有普通实例：授权后准备一次

仅当前已经运行的实例没有调试参数时使用本节；工具未运行走首次启动，已有可用通道直接复用。先说明会正常退出工具并保存未保存工作。用户已授权当前启动／重启时直接执行，不因脚本返回失败、切换命令工具或恢复上下文而重新要求同一许可；用户明确只允许一次时遵守该次数。强杀、清登录和重装仍按用户实际授权处理。

发现真实主程序入口和当前官方wechatide CLI：Mac核对CFBundleExecutable，Windows核对实际安装。CLI须支持`wechatide -c <clientName> quit`，启动前从当前安装的官方文档或注册表只读核对，通道未开时不调用可能拉起普通实例的CLI；不要将旧版`Contents/MacOS/cli`与当前wechatide混用。各平台按实际安装重新发现，不固定作者路径或版本。

由执行者在已获准核对进程并启动桌面程序的执行环境运行以下命令；脚本自动建立日志目录，已有同名日志时使用新文件保留旧证据：

```sh
node "<skill绝对目录>/scripts/prepare-debug-channel.mjs" --port <实际端口> --restart-authorized --executable "<真实主程序绝对路径>" --cli "<当前官方wechatide绝对路径>" --log "<工程外新日志绝对路径>"
```

工程未选定时可以省略--project；工程已确定时加入--project核验该工程。执行者不提前自行quit。准备脚本复查已有通道与进程：已开启则复用；查询受限则在退出前停止；其他端口或多实例则停止核对。条件明确时正常退出一次，在本次等待预算内确认退出，再由启动器传入上述CDP参数启动一次，在本次等待预算内检查真实HTTP目标列表，并对匹配的工程发出只读协议命令。未确认退出返回exit-pending，不强杀；仍在启动返回starting，继续只读检查，不重复启动。默认等待预算30秒，可用--wait-ms调整。

Mac默认通过`/usr/bin/open -n -a <实际.app> --args <CDP参数>`正常启动，并分别保存标准输出和错误，不从agent进程直接spawn应用主程序。旧的`--launch-method direct`在Mac上会在退出现有工具之前被拒绝，避免继承调用进程的沙箱和注入环境。Windows仍直接启动实际程序。启动器只移除GUI启动子进程的ELECTRON_RUN_AS_NODE，不修改agent的安全设置或安全变量。application的-n仅在已确认没有旧主进程时使用。启动请求、主进程参数、HTTP和Runtime.evaluate分别核验，open返回0或launched-unverified都不是成功。

Mac沙箱中的open可能被系统忽略调试参数，[Apple说明](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/arguments)了这一行为。主进程已出现但没有调试参数时，脚本立即返回startup-failed，保留该窗口并转用户系统终端，不等30秒、不退回直接启动主程序。已有证据表明当前执行环境会丢参数时，必须直接提供下面的终端命令，不先重试失败路径。

## agent开启失败：用户复制命令执行

当前环境已有丢弃调试参数的证据时，不需要先启动失败一次才走本节。只打开系统终端／CMD，不先启动开发者工具。说明实际原因，然后提供适合用户当前系统的一段可复制命令：Mac用系统终端，Windows用CMD。命令先检查已有通道，必要时正常退出开发者工具并带调试参数启动；先提醒保存未保存工作。由agent填入已发现的Node、skill、工程、主程序、CLI、日志的实际绝对路径及已核实的clientName，正确引用路径，不把下面的占位符直接交给用户，不要求安装新运行时。

必须先通过当前已获准的命令工具实际请求打开终端应用，再交付用户执行指令，不能只打印打开命令或直接让用户自行开终端。不传入脚本文件或待执行命令：Mac执行`open -a Terminal`；Windows在PowerShell执行`Start-Process cmd.exe`，在CMD执行`start "" cmd.exe`。在回复的代码块中给出填好实际路径的完整命令，让用户手动复制到打开的终端／CMD并回车。不生成或打开`.command`／`.cmd`启动文件，不自动输入命令或模拟回车，不要求修改安全配置。此前打开脚本文件被拒绝，不证明单独打开终端应用也被拒绝，不能据此跳过本次打开请求。仅本次单独打开应用确实失败时，说明原始错误，让用户手动打开后复制同一命令，不反复尝试。打开请求返回0不等于窗口已打开，更不代表通道已就绪；用户执行后仍由agent验证通道。

工具尚未运行时，交付上方首次启动的launch-debug-channel.mjs命令，填好实际Node、skill、主程序和新日志的绝对路径；不包含quit，不要求先打开开发者工具，也不需要先选工程。只有当前已经存在无调试参数的实例时才交付下面的prepare命令。

下面模板的--project仅在工程已确定时加入，尚未选工程时移除这一对参数，不能为执行重启命令猜选工程。

Mac模板（已有普通实例，需要正常退出后带参数启动）：

```sh
WECHATIDE_CLIENT="<已核实clientName>" "<Node绝对路径>" "<skill绝对目录>/scripts/prepare-debug-channel.mjs" --project "<工程绝对路径>" --port <实际端口> --restart-authorized --executable "<真实主程序绝对路径>" --cli "<当前官方wechatide绝对路径>" --launch-method application --log "<工程外新日志绝对路径>"
```

Windows CMD模板（不是PowerShell语法）：

```bat
set "WECHATIDE_CLIENT=<已核实clientName>"
"<Node绝对路径>" "<skill绝对目录>\scripts\prepare-debug-channel.mjs" --project "<工程绝对路径>" --port <实际端口> --restart-authorized --executable "<真实主程序绝对路径>" --cli "<当前官方wechatide绝对路径>" --log "<工程外新日志绝对路径>"
```

不让用户负责排障或判断是否测试通过。用户执行后，agent先只读检查真实HTTP；通过后才登录、选工程或打开尚未匹配的工程，再按第3步验证工程协议、保存连接身份，最后开始或恢复当前测试。starting仅表示还未就绪，project-unresolved表示需打开指定工程；两者先只读复查，不再发启动命令。命令确实失败时查看完整错误，不宣布成功、不清锁或登录状态。

交付用户启动命令后，直到用户执行完且agent完成只读通道检查，暂停所有可能自动拉起开发者工具的wechatide调用，包括登录查询、automation_runtime_info和打开工程。只可读取通道准备所需的信息、保存已有进度；不继续源码检测或采集测试证据；不能在用户退出工具时用CLI重新拉起无调试参数的实例。终端JSON是agent的诊断依据，用户无需解读或自行判断；agent核验后用普通话说明是否已开启、失败在哪一步及接下来谁做什么，不把原始JSON或旧探针报告作为结论。

## 3. 验证并使用

```sh
node "<skill绝对目录>/scripts/check-debug-channel.mjs" --project "<工程绝对路径>" --port <实际端口> --out "<工程外新连接信息JSON路径>"
node "<skill绝对目录>/scripts/read-ide-diagnostics.mjs" --project "<工程绝对路径>" --port <实际端口> --out "<工程外诊断JSON绝对路径>"
```

检查返回ready、projectMatches为1且protocol.available为true后再读诊断。--out将工程、端口、CLI路径和clientName保存到新文件，自动创建父目录，同名记录已有时保存新文件并返回connectionFile，不覆盖旧记录、不包含连接令牌。CLI字段记录当前配置，不证明CLI已授权，仍须沿用此前核实的身份。

开始后续测试、恢复长任务或连接报错时，先读取本轮连接信息，恢复同一工程、WECHATIDE_DEBUG_PORT、WECHATIDE_BIN及WECHATIDE_CLIENT。记录帮助找回参数，不能证明现在仍连接；每项测试开始前用check-debug-channel只读复查实际工程协议；未通过时暂停全部测试，不能调用automation_runtime_info绕过。通过后，点击与流程操作再用automation_runtime_info确认当前页。正常操作复用已开的工程；同一批UI采集复用一个WebSocket，诊断读取也在一个连接内完成。不同命令各自连接，不增加常驻进程，也不因上下文变短重新启动工具。UI采集复用相同端口，参数名是`--debug-port`；也可统一设置WECHATIDE_DEBUG_PORT。通道开启后不再调用启动器。read-ide-diagnostics.mjs不调用CLI登录、不打开工程、不刷新模拟器。

需要独立区分连接故障时，只读请求`http://127.0.0.1:<实际端口>/json/version`和`/json/list`；用Node原生HTTP或curl --noproxy '*'，保留stderr与退出码，完整解析JSON但不向用户暴露目标URL中的内部令牌。不能用head、tail或grep管道把失败退出码变成0，或截断JSON后宣称已核验。

## 故障定位

- 主进程无调试参数且ECONNREFUSED：通道未开启，回到第2步；不是工程换了端口，等待或刷新工程不会开启它。
- 宿主能连、agent不能连：对照同一进程、端口、访问权限和代理环境；保留真实证据，进程查询未核实的字段不补猜。
- bad option：核对GUI子进程是否继承ELECTRON_RUN_AS_NODE。
- sandbox initialization failed、FATAL或GPU process isn't usable：保留启动日志。致命错误优先于短暂的HTTP／协议成功；沙箱初始化错误出现且工程协议未通过时也不能报就绪，即使主进程还在。只在实际工程协议通过、没有致命错误时保留单条警告并继续。不再次启动、不清锁、不修改安全配置，转用户终端。
- SingletonLock权限错误或宿主安全中心待确认弹窗：保留日志并说明来源，按具体授权处理；批准后只读复查已有进程，不再次启动、不清锁或绕过权限。
- quit-failed、startup-failed、exit-pending或starting：保留error中的退出码、信号、原始输出以及launchLog指向的日志和进程检查结果，不循环重启，也不调用可能拉起普通实例的CLI掩盖失败。
