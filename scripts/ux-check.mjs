#!/usr/bin/env node
/**
 * 流程测试（独立入口）
 *
 * 跟 tap-check 的分工：
 *   tap-check  只回答「入口点得进去吗」——点一下、看当前页，一次点击的事。
 *   ux-check   回答「以用户身份把这件事做完，是什么体验」——进页面、填表、提交、
 *              看结果，并且追问：空着提交会被拦吗、拦了有提示吗、提交完有反馈吗、
 *              危险操作有没有后路、这件事一共要几下。
 *
 * 用法:
 *   node ux-check.mjs --project <工程绝对路径> [--fill 100] [--json]
 *
 * 结果写到 <工程>/.mp-autocheck/ux-report.json；退出码 0 无 P1 / 1 有 P1 / 2 用法或环境错误
 *
 * ★ 这个入口会真的往小程序里写数据（否则就还是「看按钮能不能点」）。
 *   因此它开始前备份本地存储、结束后原样还原，备份落盘及恢复核验失败时停止；服务端副作用仍需隔离，见execution.md。
 */
import fs from 'fs';
import path from 'path';
import { envStatus, openWindow, ensureReady } from './lib/wechatide.mjs';
import { analyzeNavCost } from './lib/nav-cost.mjs';
import { findForms, findDangerOps, auditUx } from './lib/ux-audit.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 ? argv[i + 1] : d;
};
const PROJECT = arg('project');
const FILL = arg('fill', '1');
const AS_JSON = argv.includes('--json');
const valuesFile = arg('values-file');
const VALUES = valuesFile ? JSON.parse(fs.readFileSync(valuesFile, 'utf8')) : {};
if (!VALUES || typeof VALUES !== 'object' || Array.isArray(VALUES)) throw Error('--values-file 必须是按页面和选择器组织的对象');

if (!PROJECT || !fs.existsSync(PROJECT) || !fs.existsSync(path.join(PROJECT, 'app.json'))) {
  console.error('用法: node ux-check.mjs --project <工程绝对路径> [--fill 100] [--json]');
  process.exit(2);
}

const log = AS_JSON ? () => {} : (s) => console.log(s);
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

log('· 检查环境');
const env = envStatus();
if (!env.cli) { console.error('wechatide CLI 不可用，需先安装微信开发者工具'); process.exit(2); }
if (!env.login) { console.error('开发者工具未登录，需先扫码：wechatide login --type image'); process.exit(2); }
log('  就绪（用户: ' + (env.user || '?') + '）');

// —— 静态：逐页找「用户能完成的任务」和「危险操作」
const nav = analyzeNavCost(PROJECT);
const tabs = new Set((nav.tabPages || []).map(String));
const plan = [];
const dangers = [];

for (const p of nav.pages.map((x) => x.page)) {
  const wxml = readText(path.join(PROJECT, p + '.wxml'));
  const js = readText(path.join(PROJECT, p + '.js'));
  if (!wxml) continue;
  const { tasks } = findForms(wxml, js);
  for (const d of findDangerOps(wxml, js)) dangers.push({ page: p, ...d });
  if (tasks.length) plan.push({ page: p, isTab: tabs.has(p), tasks });
}

log('· 静态识别到 ' + plan.length + ' 个页面有提交任务，共 ' +
  plan.reduce((s, p) => s + p.tasks.length, 0) + ' 个；危险操作 ' + dangers.length + ' 个');

try { openWindow(PROJECT, env.bin); } catch (e) { log('  打开窗口失败: ' + String(e.message).slice(0, 100)); }
if (!ensureReady(PROJECT, env.bin, { log })) { console.error('模拟器未就绪'); process.exit(2); }

log('· 流程测试开始（会真填真提交，结束后恢复并核验本地存储；服务端写入需隔离）');
const r = auditUx(PROJECT, plan, env.bin, log, {
  home: nav.home,
  homeIsTab: tabs.has(nav.home),
  fillValue: FILL,
  values: VALUES,
  backupDir: arg('backup-dir'),
});

const outDir = path.join(PROJECT, '.mp-autocheck');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'ux-report.json');
const report = {
  project: PROJECT,
  at: new Date().toISOString(),
  home: nav.home,
  tasks: r.hops,
  dangers,
  issues: r.issues,
  stats: r.stats,
  incomplete: r.incomplete,
  backupFile: r.backupFile,
  executionError: r.executionError,
  restoreError: r.restoreError,
  boundaries: [
    'toast / showModal 属微信原生层，页面 DOM 查不到：本报告里「有没有提示」是「代码里有提示分支」+「运行时有无变化」交叉判定出来的，不是直接看到的。',
    '配色、字号、间距、文案是否通顺、图标是否易懂 —— 这些机器判不了，只能人看。',
    '只走静态能确认的提交按钮（文案含保存/提交/确定等）；识别不出的不点，避免误触危险操作。',
    '危险操作只做静态判定（有没有二次确认代码），永不点击。',
  ],
};
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(r.incomplete ? 2 : r.issues.some((i) => i.level === 'P1') ? 1 : 0);
}

console.log('');
console.log('══════════════════════════════════════════════════════════');
console.log(' 流程测试结果（表单辅助结果，不代表全部用户任务完成）');
console.log('══════════════════════════════════════════════════════════');
for (const h of r.hops) {
  if (h.skipped) { console.log(' · ' + h.page + '「' + h.text + '」跳过：' + h.skipped); continue; }
  console.log(' · ' + h.page + '  →  点「' + h.text + '」');
  console.log('     空着提交：' + h.empty.kind);
  console.log('     正常提交：' + h.submit.kind + (h.filledWith ? '（' + h.filledWith + '）' : ''));
  console.log('     页内操作：' + h.tapsInPage + ' 步（填值 + 提交）');
}
if (dangers.length) {
  console.log('----------------------------------------------------------');
  console.log(' 危险操作（只检查、不点击）');
  for (const d of dangers) {
    console.log(' · ' + d.page + '「' + d.text + '」 ' + (d.confirm ? '✔ 有二次确认' : '✘ 没有二次确认，误触即丢数据'));
  }
}
for (const i of r.issues) {
  console.log(' [' + i.level + '] ' + i.rule + ' — ' + i.where);
  console.log('     ' + i.msg);
}
console.log('----------------------------------------------------------');
console.log(
  ' 提交任务 ' + r.stats.tasks + ' 个：空提交被拦住 ' + r.stats.blocked + ' 个，脏数据没拦住 ' + r.stats.leaked +
    ' 个，点了没反应 ' + r.stats.silent + ' 个；正常提交成功 ' + r.stats.ok + ' 个' +
    (r.stats.notUnique ? '；因元素不唯一跳过 ' + r.stats.notUnique + ' 个' : '')
);
console.log(' 数据还原：' + (r.stats.restored ? '全部本地键和值核验一致' : '还原失败，请手动检查'));
console.log(' 明细: ' + path.relative(process.cwd(), outFile));
console.log('══════════════════════════════════════════════════════════');

process.exit(r.incomplete ? 2 : r.issues.some((i) => i.level === 'P1') ? 1 : 0);
