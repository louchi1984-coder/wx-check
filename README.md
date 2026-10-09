# 小程序测试 · wx-check

搭配微信开发者工具，由执行者理解当前小程序并执行代码测试、点击测试、流程测试，最后做UI测试。换工程重新理解任务，不添加该工程专用测试驱动。

解压wx-check.zip到所用工具的skills目录，从[SKILL.md](SKILL.md)开始。先定位当前工具和官方接口、确认连接授权与登录，再选工程及测试号／真实AppID。不限agent、硬件型号或固定工具版本。

通道准备、诊断读取和批量UI是辅助工具，见[工具说明](references/tool-details.md)。Windows使用实际发现的WECHATIDE_BIN、WECHATIDE_DATA_DIR及必要的WECHATIDE_MODULES_DIR；批量切机型按当前目录选择，不固定历史机型。数据操作按已有授权与可靠恢复办法执行。

报告有统一的通俗总结、覆盖和证据要求，见[报告规范](references/reporting.md)。保存截图后必须读图，业务任务须确认最终结果。

## 维护检查

以下仅检查保留的通用工具，不是任何小程序的验收结果：

```sh
node scripts/debug-channel-selftest.mjs
node scripts/diagnostics-selftest.mjs
node scripts/device-live-selftest.mjs
node scripts/ui-batch-selftest.mjs
```

夹具仅用于模拟协议与失败边界，运行时在临时目录创建；发布包不含业务工程、旧测试场景或历史验证报告。内部接口升级后按能力核验，真实工程与Windows运行情况须另外实测。
