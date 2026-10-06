#!/usr/bin/env node
/**
 * 小程序自检 —— 统一入口
 *
 * 一次运行完成五个模块的体检，输出一份分级报告： *   A 工程配置与资源（静态，不需要开发者工具）
 *   B 界面布局（运行时，需开发者工具已打开项目且已登录）
 *   C 运行时报错与网络（同上）
 *   D 真编译（同上；把每个 wxml/wxss 交给开发者工具真的编译一次）
 *   E 读内容（同上；量文字宽度查截断、读页面 data 分清「空数据」与「没渲染完」、查绑定错字段）
 *
 * 执行顺序有讲究：C 先跑（要读小程序启动时的 console），E 在 B 之前跑并把每页的 data 摘要交给 B，
 * B 才能判断「空 class」是正常的空列表还是真的没渲染完。
 *
 * 用法:
 *   node selfcheck.mjs --project <工程绝对路径> [--only config|runtime|compile|content|ui|tap] [--page <页面>]
 *                      [--device <机型>] [--screenshot] [--json]
 *
 * 注意：一次运行**只操作 --project 指定的这一个工程**。不要为了「顺手验证」而对另一个工程
 * 发起操作——那会在开发者工具里多开一个模拟器，用户看到的是「任务跑到一半换了目标」。
 *
 * 退出码: 0 无 P0 / 1 存在 P0 / 2 用法或工程错误
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { envStatus, openWindow, ensureReady } from './lib/wechatide.mjs';
import { auditConfig } from './lib/config-audit.mjs';
import { auditRuntime } from './lib/runtime-audit.mjs';
import { auditCompile } from './lib/compile-audit.mjs';
import { auditContent } from './lib/content-audit.mjs';
import { auditTap } from './lib/tap-audit.mjs';
import { scanUI } from './lib/ui-scan.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes('--' + n);

const PROJECT = arg('project');
const ONLY = String(arg('only', '') || '');
const PAGE = String(arg('page', '') || '');
const AS_JSON = has('json');
const SHOT = has('screenshot');
// 真点击是写操作（会真的点按钮、切页面），必须显式开启
const TAP = has('tap') || ONLY === 'tap';
// 模拟器机型：'320'（按宽度）/ '320x568' / 'iPhone 5' / 'iPad'；换机型需关窗改配置再开窗
const DEVICE = String(arg('device', '') || '');

if (!PROJECT || !fs.existsSync(PROJECT)) {
  console.error('用法: node selfcheck.mjs --project <小程序工程绝对路径> [--only config|runtime|compile|content|ui|tap] [--page <页面>] [--device <机型>] [--screenshot] [--json]');
  process.exit(2);
}
if (PAGE && !/^[A-Za-z0-9_\-/]+$/.test(PAGE)) {
  console.error('--page 只允许字母、数字、下划线、连字符与斜杠');
  process.exit(2);
}
if (!fs.existsSync(path.join(PROJECT, 'app.json'))) {
  console.error('目标目录不是小程序工程（缺少 app.json）: ' + PROJECT);
  process.exit(2);
}
if (DEVICE) {
  if (ONLY && ONLY !== 'ui') {
    console.error('--device 只用于 UI 检测；编译等代码检查请不带机型参数执行一次');
    process.exit(2);
  }
  const entry = path.join(path.dirname(process.argv[1]), 'ui-check.mjs');
  const args = [entry, '--project', PROJECT, '--device', DEVICE,
    '--out', arg('out', path.join(os.tmpdir(), 'miniprogram-ui-' + process.pid))];
  if (PAGE) args.push('--page', PAGE);
  if (SHOT) args.push('--screenshot');
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  process.exit(result.status ?? 2);
}

const want = (m) => !ONLY || ONLY === m;
const log = (s) => console.log(s);
const report = { project: PROJECT, at: new Date().toISOString(), env: null, modules: {}, totals: { P0: 0, P1: 0, autofix: 0 } };

// ── 环境 ──────────────────────────────────────────────────────
log('· 检查环境');
const env = envStatus();
report.env = { cli: env.cli, bin: env.bin, login: env.login, user: env.user, loginExpired: env.loginExpired };
const runtimeReady = env.cli && env.login;
if (!env.cli) log('  wechatide CLI 不可用 —— 界面与运行时模块将跳过，仅跑静态体检');
else if (!env.login) log('  开发者工具未登录 —— 界面与运行时模块将跳过，仅跑静态体检');
else log('  就绪（用户: ' + (env.user || '?') + '）');

// ── A 工程配置与资源 ─────────────────────────────────────────
if (want('config')) {
  log('· 模块 A 工程配置与资源（静态）');
  const r = auditConfig(PROJECT);
  report.modules.config = { issues: r.issues, stats: r.stats };
  log('  ' + r.stats.pages + ' 页 / ' + r.stats.wxml + ' 个 wxml / ' + r.stats.components + ' 处组件引用 → P0 ' +
    r.issues.filter((i) => i.level === 'P0').length + '，P1 ' + r.issues.filter((i) => i.level === 'P1').length);
}

// ── B / C 运行时 ─────────────────────────────────────────────
// 关键：依赖开发者工具的模块必须先确认模拟器真的就绪。
// 不就绪时 automator 会静默返回空结果，报告会显示「0 问题」——比报错更危险。
let simulatorReady = runtimeReady;
let skipReason = '';
if (!env.cli) skipReason = 'wechatide CLI 不可用，需先安装微信开发者工具';
else if (!env.login) skipReason = '开发者工具未登录，需先扫码（wechatide login --type image）';

if ((want('ui') || want('runtime') || want('compile') || want('content')) && runtimeReady) {
  try {
    openWindow(PROJECT, env.bin);
  } catch (e) {
    log('  打开项目窗口失败: ' + String(e.message).slice(0, 120));
  }
  simulatorReady = ensureReady(PROJECT, env.bin, { log });
  if (!simulatorReady) skipReason = '模拟器未能在限定时间内就绪（工程首次打开或开发者工具繁忙）';
}

if (want('runtime')) {
  if (!simulatorReady) {
    report.modules.runtime = {
      skipped: true,
      reason: skipReason,
      issues: [],
      stats: { consoleLines: 0, errors: 0, warns: 0, requests: 0, failures: 0 },
    };
    log('· 模块 C 运行时报错与网络 —— 已跳过（' + skipReason + '）');
  } else {
    log('· 模块 C 运行时报错与网络');
    const r = auditRuntime(PROJECT, env.bin, log);
    report.modules.runtime = { issues: r.issues, stats: r.stats };
    log('  console ' + r.stats.consoleLines + ' 条（error ' + r.stats.errors + ' / warn ' + r.stats.warns + '）  network ' +
      r.stats.requests + ' 个请求 → P0 ' + r.issues.filter((i) => i.level === 'P0').length +
      '，P1 ' + r.issues.filter((i) => i.level === 'P1').length);
  }
}

// ── D 真编译 ─────────────────────────────────────────────────
if (want('compile')) {
  if (!simulatorReady) {
    report.modules.compile = { skipped: true, reason: skipReason, issues: [], stats: {} };
    log('· 模块 D 真编译 —— 已跳过（' + skipReason + '）');
  } else {
    log('· 模块 D 真编译');
    try {
      const r = auditCompile(PROJECT, env.bin, log);
      if (r.unavailable) {
        report.modules.compile = { unavailable: true, reason: r.reason, issues: r.issues, stats: r.stats, npm: r.npm };
        log('  ! 一次都没编过 —— 原因在工程配置/AppID：' + String(r.reason).slice(0, 120));
        log('    本模块这次给不出结论，先修工程配置（模块 A 会报同类问题）');
      } else {
        report.modules.compile = { issues: r.issues, stats: r.stats, npm: r.npm };
        log('  工程含 wxml ' + r.stats.wxml + ' 个 / wxss ' + r.stats.wxss + ' 个（各编译一次）→ 通过 ' +
          r.stats.ok + ' 类，不通过 ' + r.stats.failed + ' 类' +
          (r.stats.globalFail ? '，工程配置类报错 ' + r.stats.globalFail : '') +
          (r.stats.channelFail ? '，通道失败 ' + r.stats.channelFail : '') +
          (r.npm && r.npm.hasNpm ? '；npm 依赖 ' + r.npm.deps + ' 个，构建产物 ' + (r.npm.built ? '已存在' : '缺失') : ''));
      }
    } catch (e) {
      report.modules.compile = { error: e.message, issues: [], stats: {} };
      log('  失败: ' + String(e.message).slice(0, 160));
    }
  }
}

// ── E 读内容 ─────────────────────────────────────────────────
// 跑在模块 B 之前：它读到的每页 data 摘要交给 B，B 才能判断空 class 是正常的空列表还是没渲染完。
let pageData = {};
if (want('content')) {
  if (!simulatorReady) {
    report.modules.content = { skipped: true, reason: skipReason, issues: [], stats: {}, pageData: {} };
    log('· 模块 E 读内容 —— 已跳过（' + skipReason + '）');
  } else {
    log('· 模块 E 读内容');
    try {
      const r = auditContent(PROJECT, env.bin, log, { ready: true, pages: PAGE ? [PAGE] : undefined });
      pageData = r.pageData || {};
      report.modules.content = { issues: r.issues, stats: r.stats, pageData };
      log('  读到 data ' + r.stats.dataRead + '/' + r.stats.pages + ' 页，量文字 ' + r.stats.ellipsisChecked +
        ' 处 → 截断 ' + r.stats.truncated + '，绑定缺字段 ' + r.stats.missingRefs +
        (r.stats.measureFailed ? '，测量失败 ' + r.stats.measureFailed : ''));
    } catch (e) {
      report.modules.content = { error: e.message, issues: [], stats: {}, pageData: {} };
      log('  失败: ' + String(e.message).slice(0, 160));
    }
  }
}

if (want('ui')) {
  if (!simulatorReady) {
    report.modules.ui = {
      skipped: true,
      reason: skipReason,
      error: skipReason,
      viewport: { width: 0, height: 0 },
      pages: [],
      issues: [],
      totals: { P0: 0, P1: 0 },
      elements: 0,
      failedClasses: [],
      emptyClasses: {},
      dataState: {},
    };
    log('· 模块 B 界面布局 —— 已跳过（' + skipReason + '）');
  } else {
    log('· 模块 B 界面布局');
    try {
      const r = scanUI(PROJECT, { only: PAGE, bin: env.bin, log, screenshot: SHOT, ready: true, pageData });
      report.modules.ui = r;
      log('  ' + r.pages.length + ' 页 / ' + r.elements + ' 元素 → P0 ' + r.totals.P0 + '，P1 ' + r.totals.P1);
      if (r.elements === 0) log('  ! 未采集到任何元素 —— 结论不可信，建议重跑或检查页面是否有 class');
    } catch (e) {
      report.modules.ui = {
        error: e.message,
        pages: [],
        issues: [],
        totals: { P0: 0, P1: 0 },
        elements: 0,
        viewport: { width: 0, height: 0 },
        failedClasses: [],
        emptyClasses: {},
        dataState: {},
      };
      log('  扫描失败: ' + String(e.message).slice(0, 160));
    }
  }
}

// 单项检测只报告本轮实际执行的模块；不混入旧证据；历史报告由执行者另存。
if (ONLY) {
  report.partial = true;
  report.only = ONLY;
}

// ── G 真点击走查（写操作，本入口不执行，只提示） ─────────────
// 为什么本入口不执行它：
//   ① 它属写操作（真的点按钮、切页面），跟一堆只读采集混在一起不合适；
//   ② 实测把它接在本流程尾部时，页面导航调用会无响应、把整轮拖住（同一段调用
//      在独立进程里跑却是正常的）。隔离成独立命令最稳，也保证本报告一定能落盘。
if (want('tap')) {
  report.modules.tap = {
    ran: false,
    skipped: true,
    reason: '真点击走查属写操作，需用独立命令执行（本入口不执行）',
    issues: [],
    hops: [],
    stats: {},
  };
  log('· 模块 G 真点击走查 —— 本入口不执行（它属写操作，会真的点按钮、切页面）');
  log('  需要时单独跑这一条，结果写到 <工程>/.mp-autocheck/tap-report.json：');
  log('    node ' + path.join(path.dirname(process.argv[1] || ''), 'tap-check.mjs') + ' --project ' + PROJECT);
}

for (const m of ['config', 'runtime', 'compile', 'content', 'tap']) {
  const mod = report.modules[m];
  if (!mod || !mod.issues) continue;
  report.totals.P0 += mod.issues.filter((i) => i.level === 'P0').length;
  report.totals.P1 += mod.issues.filter((i) => i.level === 'P1').length;
  report.totals.autofix += mod.issues.filter((i) => i.autofix).length;
}
if (report.modules.ui && report.modules.ui.totals) {
  report.totals.P0 += report.modules.ui.totals.P0;
  report.totals.P1 += report.modules.ui.totals.P1;
}

// ── 落盘 ─────────────────────────────────────────────────────
const outDir = path.join(PROJECT, '.mp-autocheck');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.totals.P0 ? 1 : 0);
}

// ── 打印报告 ──────────────────────────────────────────────────
const L = '─'.repeat(58);
const hr = () => console.log(L);
console.log('\n══════════════════════════════════════════════════════════');
console.log(' 小程序自检报告');
console.log(' 工程: ' + report.project);
console.log(' 环境: wechatide ' + (env.cli ? '可用' : '不可用') + ' / 登录 ' + (env.login ? '已登录' : '未登录') +
  '   模块: ' + Object.keys(report.modules).join(' + '));
console.log('══════════════════════════════════════════════════════════');

const printIssues = (issues) => {
  const ind = (s) => String(s).split('\n').map((l) => '        ' + l).join('\n');
  for (const i of issues) {
    console.log('   [' + i.level + '] ' + i.rule + (i.autofix ? '  [可自动修]' : ''));
    if (i.where) console.log('        位置: ' + i.where);
    console.log(ind(i.msg));
    if (i.fix) console.log('        改法: ' + i.fix);
  }
};

const c = report.modules.config;
if (c) {
  console.log('\n── 模块 A · 工程配置与资源 ─────────────────────────────');
  if (!c.issues.length) console.log('   未发现问题');
  printIssues(c.issues.filter((i) => i.level === 'P0'));
  printIssues(c.issues.filter((i) => i.level === 'P1'));
}

const nav = report.modules.nav; // 旧报告遗留数据（模块 F 已移除），仅当 --only 合并进来时打印
if (nav && nav.fromPreviousRun) {
  console.log('\n── 模块 F · 操作成本（来自上一次运行） ─────────────────');
  if (nav.error) console.log('   ! ' + nav.error);
  else {
    for (const p of nav.pages) {
      const entry = p.entryTaps === null ? '进不去' : p.entryTaps + ' 下';
      const back = p.backTaps === null ? '—' : p.backTaps + ' 下';
      console.log('   ' + p.page.padEnd(26) + '进入 ' + entry.padEnd(7) + ' 回首页 ' + back.padEnd(6) +
        ' 可点 ' + String(p.tapCount).padStart(2) + ' 个' + (p.isTab ? '  [底部 tab]' : ''));
    }
    printIssues(nav.issues || []);
  }
}

const r2 = report.modules.runtime;
if (r2) {
  console.log('\n── 模块 C · 运行时报错与网络 ───────────────────────────');
  if (r2.skipped) console.log('   已跳过 —— ' + r2.reason);
  else {
    if (!r2.issues.length) console.log('   未发现问题');
    printIssues(r2.issues);
  }
}

const cp = report.modules.compile;
if (cp) {
  console.log('\n── 模块 D · 真编译 ─────────────────────────────────────');
  if (cp.skipped) console.log('   已跳过 —— ' + cp.reason);
  else if (cp.error) console.log('   ! ' + cp.error);
  else {
    if (cp.unavailable) {
      console.log('   ! 无法真编译 —— ' + String(cp.reason).slice(0, 200));
      console.log('     本模块这次没有结论（工程配置或 AppID 问题），不要当成「编译通过」');
    } else if (!cp.issues.length) {
      console.log('   wxml ' + cp.stats.wxml + ' 个 / wxss ' + cp.stats.wxss + ' 个 —— 全部编译通过');
    }
    printIssues(cp.issues);
  }
}

const tp = report.modules.tap;
if (tp) {
  console.log('\n── 模块 G · 真点击走查 ─────────────────────────────────');
  if (tp.skipped) console.log('   未执行 —— ' + tp.reason);
  else if (tp.error) console.log('   ! ' + tp.error);
  else {
    for (const h of tp.hops || []) {
      if (h.skipped) {
        console.log('   ' + h.to.padEnd(26) + '跳过：' + h.skipped);
        continue;
      }
      console.log('   从 ' + h.from + ' 点「' + h.text + '」');
      console.log('        → ' + h.to + '   ' + (h.ok ? '✔ 真的进去了' : '✘ 没进去') +
        '（点 ' + h.actualTaps + ' 下，页栈 ' + h.stackDepth + ' 层' +
        (h.stackDepth > 1 ? '，回首页约 ' + (h.stackDepth - 1) + ' 下' : '') + '）');
      if (h.brokeAt) console.log('        ' + h.brokeAt);
    }
    if (!tp.issues.length) console.log('   实测：所有入口都能真的点进去');
    else printIssues(tp.issues);
  }
}

const ct = report.modules.content;
if (ct) {
  console.log('\n── 模块 E · 读内容 ─────────────────────────────────────');
  if (ct.skipped) console.log('   已跳过 —— ' + ct.reason);
  else if (ct.error) console.log('   ! ' + ct.error);
  else {
    const s = ct.stats;
    console.log('   读到 data ' + s.dataRead + '/' + s.pages + ' 页；量文字 ' + s.ellipsisChecked +
      ' 处（截断候选 ' + s.ellipsisCandidates + ' 个 class）');
    if (!ct.issues.length) console.log('   没有文字被截断，也没发现引用错的字段');
    printIssues(ct.issues);
  }
}

const u = report.modules.ui;
if (u) {
  console.log('\n── 模块 B · 界面布局 ───────────────────────────────────');
  if (u.skipped) {
    console.log('   已跳过 —— ' + u.reason);
  } else {
    if (u.error) console.log('   ! ' + u.error);
    console.log('   视口 ' + u.viewport.width + ' × ' + u.viewport.height + '，扫描 ' + u.pages.length + ' 页 / ' + u.elements + ' 个元素');
    // 逐页只列「定位到具体元素」的问题（横向溢出）；
    // 触控区这类全局性结论由 ui-scan 跨页聚合后放在 u.issues 里，直接打印，不再二次统计。
    for (const p of u.pages) {
      if (p.error) {
        console.log('   ! ' + p.page + ' ' + p.error);
        continue;
      }
      for (const i of p.issues) {
        console.log('   [' + i.level + '] ' + p.page + '  ' + i.rule + '  .' + i.class + '  ' + i.msg);
      }
    }
    for (const i of u.issues || []) {
      console.log('   [' + i.level + '] 全工程  ' + i.rule + '  ' + i.msg);
      if (i.fix) console.log('        改法: ' + i.fix);
    }
    if (u.failedClasses.length) {
      console.log('   （' + u.failedClasses.length + ' 个 class 未取到数据，通常是条件渲染未出现，非错误）');
    }
    if (u.elements === 0 && !u.error) {
      console.log('   ! 未采集到任何元素，本次界面结论不可信，请重跑');
    }
  }
}

console.log('');
hr();
const skippedMods = ['config', 'runtime', 'compile', 'content', 'ui', 'tap'].filter((m) => {
  const mod = report.modules[m];
  return mod && (mod.skipped || mod.unavailable);
});
console.log(' 合计: P0 ' + report.totals.P0 + ' 处（必须修）    P1 ' + report.totals.P1 + ' 处（可定夺）' +
  (report.totals.autofix ? '    其中可自动修 ' + report.totals.autofix + ' 处' : ''));
if (skippedMods.length) {
  console.log(' 注意: 有 ' + skippedMods.length + ' 个模块没给出结论（' + skippedMods.join('、') + '），以上结论不完整');
}
console.log(' 明细: ' + path.relative(process.cwd(), path.join(outDir, 'report.json')));
hr();

process.exit(report.totals.P0 ? 1 : 0);
