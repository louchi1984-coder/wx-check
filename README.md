# 小程序测试 · wx-check

搭配微信开发者工具，检查原生微信小程序：

1. **代码测试**：程序有没有写对，编译、运行异常及工具诊断。
2. **UI 测试**：界面显示是否正常，多机型采集与截图审阅。
3. **点击测试**：真实点击后是否出现预期反应。
4. **流程测试**：识别用户任务，核验数据和最终结果。

不限定 agent、聊天平台或硬件型号。运行测试依赖微信开发者工具；静态检查和离线自检可独立执行。

## 使用

下载 Releases 中的 `wx-check.zip`，解压到所用工具支持的 skills 目录；或将本仓库克隆到该目录下的 `wx-check` 文件夹。安装入口遵循所用工具的说明。

向执行者说明目标，例如：“使用小程序测试，检查这个工程的代码和 UI。”从 [SKILL.md](SKILL.md) 开始，先定位工具、确认连接授权及登录，再选择项目及测试号／真实 AppID。

```sh
node scripts/selftest.mjs
node scripts/selfcheck.mjs --project <源码绝对路径> --only config
node scripts/ui-check.mjs --project <源码绝对路径> --matrix --out <工程外报告目录>
```

Windows 使用实际发现的 `WECHATIDE_BIN`、`WECHATIDE_DATA_DIR`、`WECHATIDE_MODULES_DIR`，详见 [跨平台验证](references/platform-validation.md)。批量 UI 需要已授权的本机调试通道，首次开启可能需要重启一次，之后复用同一窗口。

## 判定与修复

报告区分通过、失败、部分覆盖及未覆盖。截图保存后仍需读图；保存弹窗不能代替落库与重读验证。安装、认证及用户数据写入／删除／清空／导出前须确认授权范围。支持单项修复与完整结果闭环，见 [修复流程](references/repair.md)。

## 验证范围

微信开发者工具 Stable `2.02.2608080`、内置 skill `0.3.11` 在 Mac 与 Windows 上实测。Windows 已验证 CLI、授权登录、真实编译、43款机型采集、6款精测截图审阅及两款主流机型非数据点击。完整诊断面板及数据写入／删除／清空／导出流程尚未完整验证，不宣称 Windows 四类检测全部通过。

离线自检共97项：

```sh
node scripts/selftest.mjs
node scripts/device-selftest.mjs
node scripts/device-live-selftest.mjs
node scripts/ui-batch-selftest.mjs
```

自检夹具运行时在系统临时目录生成并清理；发布包不包含 `.wxml`、`.wxss`。内部机型切换接口与工具版本有关，其他版本需重新验证。

新版补齐条件按钮检查、工程外存储备份、异常恢复及核对、多字段输入。117项回归通过；新增交互保护采用隔离模拟驱动，不等于Windows或WorkBuddy新版完整流程已实测。
