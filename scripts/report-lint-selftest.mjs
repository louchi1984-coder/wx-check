#!/usr/bin/env node
/**
 * 报告校验回归 —— 只处理内存里的 Markdown 和临时文件，不连接开发者工具。
 *   node scripts/report-lint-selftest.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lintReport } from './report-lint.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('✓ ' + name); }
  catch (e) { process.exitCode = 1; console.log('✗ ' + name + '\n  ' + e.message); }
};

const GOOD = `# 小程序检测报告

## 先看结论
这次检查了记账小程序的代码和按钮点击。编译没有报错，开发者工具里有两个面板还没读到。有一个按钮点击后看不出反应，建议确认。流程和界面本轮没有测。

## 1. 本轮信息
- 工程：记账（/work/accounting）
- 检测时间：2026-10-07 10:00—10:30（UTC+8）
- 代码版本：有未提交修改
- 环境：macOS，开发者工具 2.02.2608080，测试号
- 本轮范围：代码测试 → 点击测试
- 阶段：检测后

## 2. 结果总览
代码测试部分完成，点击测试已完成，有一个按钮待确认。

| 检测项目 | 完成状态 | 检查结果 | 已确认问题数 | 未覆盖项数 |
| --- | --- | --- | --- | --- |
| 1代码 | 部分完成 | 未发现问题 | 0 | 2 |
| 3点击 | 已完成 | 待确认 | 0 | 0 |
| 4流程 | 未执行 | 无法判断 | 未统计 | 未统计 |
| 2UI | 未执行 | 无法判断 | 未统计 | 未统计 |

## 3. 覆盖与证据
### 1代码测试
代码测试在已覆盖范围内没有发现问题，问题面板和输出面板还没读到。采集时间 2026-10-07 10:12。证据：[诊断原始数据](evidence/diagnostics-raw.json)。

| 来源 | 状态 | 说明 |
| --- | --- | --- |
| 构建 | 已检查 | 读到消息队列 |
| 调试器 | 部分覆盖 | 只读到命令行缓冲 |
| 问题面板 | 未覆盖 | 脚本不读取 |
| 输出 | 未覆盖 | 脚本不读取 |
| 调试控制台 | 不适用 | 没有调试会话 |
| 代码质量 | 已检查 | 读到 13 项 |
| 终端 | 不适用 | 工程没有构建命令 |

### 3点击测试
点击测试在 iPhone 15 Pro Max 机型上完成，其中一个按钮没有可见反应。时间 2026-10-07 10:25。证据：[点击矩阵](evidence/tap-matrix.json)。

| 页面 | 控件 | 机型 | 预期 | 实际 |
| --- | --- | --- | --- | --- |
| 首页 | 加号按钮 | iPhone 15 Pro Max | 页面数据变化 | 页面数据变化 |

### 4流程测试
本轮未选择。

### 2UI测试
本轮未选择。

## 4. 问题与修复建议
| 问题编号 | 归属检测 | 问题及使用影响 | 处理建议 | 当前状态 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 无 | 无 | 无 | 无 | 无 | 无 |

## 5. 未覆盖与阻塞
| 检测项目/检查项 | 原因 | 对结论的影响 | 补测需要什么 |
| --- | --- | --- | --- |
| 代码：问题面板 | 脚本不读取 | 面板状态未知 | 用窗口可访问性读取 |
| 代码：输出面板 | 脚本不读取 | 面板状态未知 | 定位原始日志核对 |

## 6. 修复与重测
本轮未执行修复。

## 7. 下一步
- 待确认：首页加号按钮是否需要先满足条件。
- 补测：问题面板和输出面板。
`;

const lint = (md, opts = {}) => lintReport(md, { fileExists: () => true, ...opts });
const rules = (r) => r.errors.map((e) => e.rule);
const mut = (from, to, md = GOOD) => {
  assert.ok(md.includes(from), '测试夹具里找不到：' + from.slice(0, 30));
  return md.replace(from, to);
};
const PROBLEM_HEAD = '| 无 | 无 | 无 | 无 | 无 | 无 |';
const problemRow = (id, state = '未修复') => `| ${id} | 点击 | 加号按钮无反应 | 待确认 | ${state} | [点击矩阵](evidence/tap-matrix.json) |`;

t('合格报告：无错误', () => {
  const r = lint(GOOD);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

t('围栏代码块里的模板占位符不参与校验', () => {
  const md = GOOD + '\n```markdown\n<用3—5句普通话说明>\nTODO 走查\n```\n';
  assert.deepEqual(lint(md).errors, []);
});

t('缺少固定章节 → section-missing', () => {
  const md = GOOD.replace(/## 5\. 未覆盖与阻塞[\s\S]*?(?=## 6\.)/, '');
  assert.ok(rules(lint(md)).includes('section-missing'));
});

t('章节顺序颠倒 → section-order', () => {
  const md = mut('## 7. 下一步', '## 6.5 占位').replace('## 6. 修复与重测', '## 7. 下一步').replace('## 6.5 占位', '## 6. 修复与重测');
  assert.ok(rules(lint(md)).includes('section-order'));
});

t('标题不对 → title', () => {
  assert.ok(rules(lint(mut('# 小程序检测报告', '# 检测报告'))).includes('title'));
});

t('先看结论含技术词 → summary-jargon', () => {
  assert.ok(rules(lint(mut('编译没有报错', 'P0 为 0，模块 B 通过'))).includes('summary-jargon'));
});

t('先看结论为空 → summary-empty', () => {
  const md = GOOD.replace(/## 先看结论\n[^\n]+\n/, '## 先看结论\n');
  assert.ok(rules(lint(md)).includes('summary-empty'));
});

t('总览状态词不在词表 → overview-status', () => {
  assert.ok(rules(lint(mut('| 部分完成 |', '| 完成 |'))).includes('overview-status'));
});

t('有未覆盖项却标已完成 → overview-consistency', () => {
  assert.ok(rules(lint(mut('| 3点击 | 已完成 | 待确认 | 0 | 0 |', '| 3点击 | 已完成 | 待确认 | 0 | 1 |'))).includes('overview-consistency'));
});

t('未执行时未覆盖项数写 0 → overview-count；写“未统计”才合法', () => {
  assert.ok(rules(lint(mut('| 4流程 | 未执行 | 无法判断 | 未统计 | 未统计 |', '| 4流程 | 未执行 | 无法判断 | 0 | 0 |'))).includes('overview-count'));
});

t('未执行却写“未发现问题” → overview-result', () => {
  assert.ok(rules(lint(mut('| 2UI | 未执行 | 无法判断 |', '| 2UI | 未执行 | 未发现问题 |'))).includes('overview-result'));
});

t('总览行顺序不对或少一行 → overview-row', () => {
  assert.ok(rules(lint(mut('| 2UI | 未执行 | 无法判断 | 未统计 | 未统计 |\n', ''))).includes('overview-row'));
});

t('已确认问题数大于 0 却写“未发现问题” → overview-consistency', () => {
  assert.ok(rules(lint(mut('| 1代码 | 部分完成 | 未发现问题 | 0 | 2 |', '| 1代码 | 部分完成 | 未发现问题 | 1 | 2 |'))).includes('overview-consistency'));
});

t('总览问题数合计大于第 4 节行数 → problem-count', () => {
  const md = mut('| 1代码 | 部分完成 | 未发现问题 | 0 | 2 |', '| 1代码 | 部分完成 | 发现问题 | 1 | 2 |');
  assert.ok(rules(lint(md)).includes('problem-count'));
});

t('总览未覆盖项数与第 5 节明细不一致 → uncovered-count', () => {
  const md = mut('| 代码：输出面板 | 脚本不读取 | 面板状态未知 | 定位原始日志核对 |\n', '');
  assert.ok(rules(lint(md)).includes('uncovered-count'));
});

t('未覆盖项缺少原因 → uncovered-row', () => {
  assert.ok(rules(lint(mut('| 代码：输出面板 | 脚本不读取 |', '| 代码：输出面板 | 无 |'))).includes('uncovered-row'));
});

t('本轮信息缺项或阶段写错 → info-missing / stage', () => {
  assert.ok(rules(lint(mut('- 环境：macOS，开发者工具 2.02.2608080，测试号\n', ''))).includes('info-missing'));
  assert.ok(rules(lint(mut('- 阶段：检测后', '- 阶段：第二轮'))).includes('stage'));
});

t('第 3 节：缺小节、缺证据时间、缺必填面板 → coverage-*', () => {
  assert.ok(rules(lint(mut('### 2UI测试\n本轮未选择。\n\n', ''))).includes('coverage-section'));
  assert.ok(rules(lint(mut('采集时间 2026-10-07 10:12。', '采集时间不详。'))).includes('coverage-time'));
  assert.ok(rules(lint(mut('| 代码质量 | 已检查 | 读到 13 项 |\n', ''))).includes('coverage-keywords'));
});

t('第 3 节：小节以表格开头，没有通俗结论 → coverage-summary', () => {
  // 去掉小节开头的通俗结论段，让小节第一行直接是表格
  const md = mut('点击测试在 iPhone 15 Pro Max 机型上完成，其中一个按钮没有可见反应。时间 2026-10-07 10:25。证据：[点击矩阵](evidence/tap-matrix.json)。\n\n', '');
  assert.ok(rules(lint(md)).includes('coverage-summary'));
});

t('未执行项目的小节必须写“本轮未选择” → coverage-unselected', () => {
  assert.ok(rules(lint(mut('### 4流程测试\n本轮未选择。', '### 4流程测试\n还没做。'))).includes('coverage-unselected'));
});

t('问题表：词表、重复编号、缺证据', () => {
  assert.ok(rules(lint(mut(PROBLEM_HEAD, problemRow('BUG-1').replace('| 待确认 | 未修复 |', '| 马上改 | 未修复 |')))).includes('problem-enum'));
  assert.ok(rules(lint(mut(PROBLEM_HEAD, problemRow('BUG-1', '已解决')))).includes('problem-enum'));
  assert.ok(rules(lint(mut(PROBLEM_HEAD, problemRow('BUG-1') + '\n' + problemRow('BUG-1')))).includes('problem-dup'));
  assert.ok(rules(lint(mut(PROBLEM_HEAD, problemRow('BUG-1').replace('[点击矩阵](evidence/tap-matrix.json)', '无')))).includes('problem-row'));
  assert.deepEqual(lint(mut(PROBLEM_HEAD, problemRow('BUG-1'))).errors, []);
});

t('问题状态是“复测通过”但第 6 节没有记录 → repair-state', () => {
  assert.ok(rules(lint(mut(PROBLEM_HEAD, problemRow('BUG-1', '复测通过')))).includes('repair-state'));
});

t('第 6 节：引用不存在的问题编号、缺复测结果', () => {
  const head = '| 问题编号 | 修复范围与内容 | 复测场景 | 复测结果 | 证据 |\n| --- | --- | --- | --- | --- |\n';
  const md = mut('本轮未执行修复。', head + '| BUG-9 | 改了 | 重点一次 | 复测通过 | [点击矩阵](evidence/tap-matrix.json) |');
  assert.ok(rules(lint(md)).includes('repair-ref'));
  const md2 = mut(PROBLEM_HEAD, problemRow('BUG-1', '已改待复测')).replace('本轮未执行修复。', head + '| BUG-1 | 改了 | 重点一次 | 无 | [点击矩阵](evidence/tap-matrix.json) |');
  assert.ok(rules(lint(md2)).includes('repair-result'));
});

t('修复与重测配套完整时通过', () => {
  const head = '| 问题编号 | 修复范围与内容 | 复测场景 | 复测结果 | 证据 |\n| --- | --- | --- | --- | --- |\n';
  const md = mut(PROBLEM_HEAD, problemRow('BUG-1', '复测通过')).replace('本轮未执行修复。', head + '| BUG-1 | 改了按钮处理函数 | 原触发步骤 | 复测通过 | [点击矩阵](evidence/tap-matrix.json) |');
  assert.deepEqual(lint(md).errors, []);
});

t('模板占位符、待填、禁用词 → placeholder / banned-term', () => {
  assert.ok(rules(lint(mut('- 代码版本：有未提交修改', '- 代码版本：<提交号>'))).includes('placeholder'));
  assert.ok(rules(lint(mut('- 代码版本：有未提交修改', '- 代码版本：TODO'))).includes('placeholder'));
  assert.ok(rules(lint(mut('读到消息队列', '走查了消息队列'))).includes('banned-term'));
});

t('证据链接：文件不存在报错，绝对路径只警告，--no-links 跳过', () => {
  const missing = lint(GOOD, { fileExists: () => false });
  assert.ok(rules(missing).includes('link-missing'));
  const abs = lint(mut('(evidence/tap-matrix.json)', '(/Users/x/tap-matrix.json)'));
  assert.deepEqual(abs.errors, []);
  assert.ok(abs.warnings.some((w) => w.rule === 'link-absolute'));
  assert.deepEqual(lint(GOOD, { fileExists: () => false, checkLinks: false }).errors, []);
  // 网络链接不检查文件是否存在（夹具里其他本地链接仍会被报缺失，所以只核对这一条）
  const web = lint(mut('(evidence/tap-matrix.json)', '(https://example.com/a.json)'), { fileExists: () => false });
  assert.ok(!web.errors.some((e) => e.msg.includes('example.com')));
  assert.ok(web.errors.some((e) => e.msg.includes('diagnostics-raw')));
});

t('CLI：合格报告退出码 0，不合格 1，缺参数 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-check-lint-'));
  try {
    const good = path.join(dir, 'good.md');
    const bad = path.join(dir, 'bad.md');
    fs.writeFileSync(good, GOOD);
    fs.writeFileSync(bad, GOOD.replace('## 7. 下一步', '## 7. 后续'));
    const run = (args) => spawnSync(process.execPath, [path.join(here, 'report-lint.mjs'), ...args], { encoding: 'utf8', timeout: 20000 });
    const ok = run(['--report', good, '--no-links']);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /校验通过/);
    const no = run(['--report', bad, '--no-links']);
    assert.equal(no.status, 1);
    assert.match(no.stdout, /section-missing/);
    assert.equal(JSON.parse(run(['--report', bad, '--no-links', '--json']).stdout).ok, false);
    assert.equal(run([]).status, 2);
    assert.equal(run(['--report', path.join(dir, 'nope.md')]).status, 2);
    const linked = run(['--report', good]);
    assert.equal(linked.status, 1, '证据文件不存在时应报错');
    assert.match(linked.stdout, /link-missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(pass + ' 项报告校验回归通过' + (process.exitCode ? '，存在失败项' : ''));
