#!/usr/bin/env node
/**
 * 真点击走查（独立入口）
 *
 * 为什么单独一个入口、不塞进 selfcheck 的六模块长流程：
 *   ① 它是**写操作**（真的点按钮、切页面），跟一堆只读采集混在一起不合适；
 *   ② 实测把它接在长流程尾部时，页面导航调用会卡住不返回（同一段调用单独跑却正常），
 *      根因指向「长流程里模拟器/automator 的状态」，隔离成独立进程最稳。
 *
 * 用法:
 *   node tap-check.mjs --project <工程绝对路径>
 *
 * 结果写到 <工程>/.mp-autocheck/tap-report.json；退出码 0 全部进去过 / 1 有进不去的 / 2 用法或环境错误
 */
import fs from 'fs';
import path from 'path';
import { envStatus, openWindow, ensureReady } from './lib/wechatide.mjs';
import { analyzeNavCost } from './lib/nav-cost.mjs';
import { auditTap } from './lib/tap-audit.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 ? argv[i + 1] : d;
};
const PROJECT = arg('project');
const AS_JSON = argv.includes('--json');

if (!PROJECT || !fs.existsSync(PROJECT)) {
  console.error('用法: node tap-check.mjs --project <工程绝对路径> [--json]');
  process.exit(2);
}
if (!fs.existsSync(path.join(PROJECT, 'app.json'))) {
  console.error('目标目录不是小程序工程（缺少 app.json）: ' + PROJECT);
  process.exit(2);
}

const log = AS_JSON ? () => {} : (s) => console.log(s);

log('· 检查环境');
const env = envStatus();
if (!env.cli) {
  console.error('wechatide CLI 不可用，需先安装微信开发者工具');
  process.exit(2);
}
if (!env.login) {
  console.error('开发者工具未登录，需先扫码：wechatide login --type image');
  process.exit(2);
}
log('  就绪（用户: ' + (env.user || '?') + '）');

try {
  openWindow(PROJECT, env.bin);
} catch (e) {
  log('  打开项目窗口失败: ' + String(e.message).slice(0, 120));
}
const ready = ensureReady(PROJECT, env.bin, { log });
if (!ready) {
  console.error('模拟器未就绪，无法做真点击走查');
  process.exit(2);
}

const nav = analyzeNavCost(PROJECT);
const entries = nav.edgeDetails || [];
if (!entries.length) {
  log('· 静态分析里没有「点一下会跳页」的元素，无需点击');
}

log('· 真点击走查（只点静态能确定是导航的元素）');
const r = auditTap(PROJECT, entries, env.bin, log, {
  home: nav.home,
  tabPages: nav.tabPages || [],
});

const outDir = path.join(PROJECT, '.mp-autocheck');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'tap-report.json');
const report = {
  project: PROJECT,
  at: new Date().toISOString(),
  home: nav.home,
  hops: r.hops,
  stats: r.stats,
  issues: r.issues,
};
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(r.stats.failed ? 1 : 0);
}

console.log('');
console.log('══════════════════════════════════════════════════════════');
console.log(' 真点击走查结果');
console.log('══════════════════════════════════════════════════════════');
for (const h of r.hops) {
  if (h.skipped) {
    console.log(' ' + h.to.padEnd(26) + '跳过：' + h.skipped);
    continue;
  }
  console.log(' 从 ' + h.from + ' 点「' + h.text + '」');
  console.log(
    '     → ' + h.to + '   ' + (h.ok ? '✔ 真的进去了' : '✘ 没进去') +
      '（点 ' + h.actualTaps + ' 下，页栈 ' + h.stackDepth + ' 层' +
      (h.stackDepth > 1 ? '，回首页约 ' + (h.stackDepth - 1) + ' 下' : '') + '）'
  );
  if (h.brokeAt) console.log('     ' + h.brokeAt);
}
for (const i of r.issues) {
  console.log(' [' + i.level + '] ' + i.rule + ' — ' + i.where);
  console.log('     ' + i.msg);
}
console.log('----------------------------------------------------------');
console.log(
  ' 目标页 ' + r.stats.targets + ' 个：真的进去了 ' + r.stats.verified + ' 个，没进去 ' + r.stats.failed +
    ' 个' + (r.stats.skipped ? '，跳过 ' + r.stats.skipped + ' 个' : '')
);
if (r.stats.resetFailed) console.log(' 注意: 复位到首页连续无响应，本次结论不完整');
console.log(' 明细: ' + path.relative(process.cwd(), outFile));
console.log('══════════════════════════════════════════════════════════');

process.exit(r.stats.failed ? 1 : 0);
