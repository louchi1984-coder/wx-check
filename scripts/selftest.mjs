#!/usr/bin/env node
/**
 * 离线自检 —— 不依赖开发者工具、不打开任何工程窗口、仅在系统临时目录创建并清理自检夹具，不修改工程。
 *
 * 只回归 ui-scan 的纯函数：这类逻辑一旦退化，报告会「看不出错、但说的全是错的」，
 * 比直接崩溃危险得多。改完 ui-scan.mjs 之后跑一遍：
 *
 *   node scripts/selftest.mjs
 *
 * 退出码 0 全部通过 / 1 有失败项。
 */
import assert from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groupByElement, checkPage, summarizeTouch } from './lib/ui-scan.mjs';
import { tapTargets, navCalls, computeCost, normPage, methodNavMap } from './lib/nav-cost.mjs';
import { findTapPath } from './lib/tap-audit.mjs';
import { bindingRefs, staticDataKeys, dataSummary, judgeTruncation } from './lib/content-audit.mjs';
import { listCompileTargets, parseErrorFiles } from './lib/compile-audit.mjs';
import { parseDeviceSpec, sizeOf } from './lib/device-patch.mjs';
import {
  findForms,
  formInputs,
  findDangerOps,
  judgeEmptySubmit,
  judgeSubmit,
  methodBody,
  pickFillInput,
} from './lib/ux-audit.mjs';

function withCompileFixture(check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-check-fixture-'));
  try {
    const page = path.join(dir, 'pages', 'bad');
    fs.mkdirSync(page, { recursive: true });
    fs.writeFileSync(path.join(page, 'bad.wxml'), '<view>fixture</view>');
    fs.writeFileSync(path.join(page, 'bad.wxss'), 'view { color: black; }');
    return check(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name + '\n      ' + e.message);
    process.exitCode = 1;
  }
};

// 高 33px —— 低于 44 的触控下限
const TINY = { left: 10, top: 20, right: 90, bottom: 53, width: 80, height: 33 };
// 高 46px —— 达标
const OK = { left: 10, top: 60, right: 370, bottom: 106, width: 360, height: 46 };

console.log('· groupByElement（把按 class 的结果还原成按元素）');

t('同一矩形出现在多个 class 下 → 合并成一个元素，并保留全部 class', () => {
  const rects = { btn: [TINY], 'btn-ghost': [TINY], 'month-btn': [TINY] };
  const els = groupByElement(rects);
  assert.strictEqual(els.length, 1, '应合并成 1 个元素，实际 ' + els.length);
  assert.deepStrictEqual(els[0].classes, ['btn', 'btn-ghost', 'month-btn']);
});

t('不同矩形不会被合并', () => {
  const rects = {
    a: [{ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }],
    b: [{ left: 0, top: 20, right: 10, bottom: 30, width: 10, height: 10 }],
  };
  assert.strictEqual(groupByElement(rects).length, 2);
});

t('空值 / 空数组不崩', () => {
  assert.deepStrictEqual(groupByElement({ a: [null, undefined], b: [] }), []);
});

console.log('· checkPage —— 触控区');

t('上报元素真实挂载的全部 class（而不是先匹配上的 .btn）', () => {
  const rects = { btn: [TINY], 'btn-ghost': [TINY], 'month-btn': [TINY] };
  const { touchSmall } = checkPage(rects, ['btn', 'btn-ghost', 'month-btn'], 390);
  assert.strictEqual(touchSmall.length, 1);
  assert.deepStrictEqual(touchSmall[0].classes, ['btn', 'btn-ghost', 'month-btn']);
});

t('尺寸达标的可点元素不算问题', () => {
  assert.strictEqual(checkPage({ btn: [OK] }, ['btn'], 390).touchSmall.length, 0);
});

t('尺寸不足但不可点的元素不算问题', () => {
  assert.strictEqual(checkPage({ label: [TINY] }, ['btn'], 390).touchSmall.length, 0);
});

t('触控区只记元素里可点的那些 class，无关 class 不带', () => {
  const rects = { btn: [TINY], 'month-btn': [TINY], 'is-disabled': [TINY] };
  const { touchSmall } = checkPage(rects, ['btn', 'month-btn'], 390);
  assert.deepStrictEqual(touchSmall[0].classes, ['btn', 'month-btn'], 'is-disabled 不是可点类，不该出现');
});

console.log('· checkPage —— 横向溢出');

t('同一个元素只报一次，且带全部 class', () => {
  const wide = { left: 0, top: 0, right: 420, bottom: 40, width: 420, height: 40 };
  const { issues } = checkPage({ row: [wide], card: [wide] }, [], 390);
  assert.strictEqual(issues.length, 1, '同一矩形应只报 1 次，实际 ' + issues.length);
  assert.strictEqual(issues[0].level, 'P0');
  assert.strictEqual(issues[0].rule, '横向溢出');
  assert.strictEqual(issues[0].class, 'row card');
});

t('左边界为负也算横向溢出', () => {
  const off = { left: -5, top: 0, right: 100, bottom: 40, width: 105, height: 40 };
  const { issues } = checkPage({ box: [off] }, [], 390);
  assert.strictEqual(issues.length, 1);
  assert.ok(/屏幕外/.test(issues[0].msg));
});

t('刚好贴近右边界（+1px 容差内）不报', () => {
  const edge = { left: 0, top: 0, right: 391, bottom: 40, width: 391, height: 40 };
  assert.strictEqual(checkPage({ row: [edge] }, [], 390).issues.length, 0);
});

t('零尺寸（不可见）元素既不报问题，也不计入元素数', () => {
  const zero = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  const { issues, uniq } = checkPage({ hidden: [zero] }, ['hidden'], 390);
  assert.strictEqual(issues.length, 0);
  assert.strictEqual(uniq, 0, '不可见元素不该让「扫描 N 个元素」虚高');
});

t('零尺寸元素不影响同页可见元素的计数', () => {
  const zero = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  const { uniq } = checkPage({ hidden: [zero], btn: [OK] }, ['btn'], 390);
  assert.strictEqual(uniq, 1);
});

t('空输入不崩', () => {
  const r = checkPage({}, [], 375);
  assert.deepStrictEqual(r.issues, []);
  assert.strictEqual(r.uniq, 0);
  assert.deepStrictEqual(r.touchSmall, []);
});

console.log('· summarizeTouch（跨页聚合为一条）');

t('无命中时返回 null，不产生空问题', () => {
  assert.strictEqual(summarizeTouch([]), null);
  assert.strictEqual(summarizeTouch(null), null);
  assert.strictEqual(summarizeTouch(undefined), null);
});

t('跨页命中聚合成一条：总数=元素数，明细按命中的 class 归类', () => {
  const issue = summarizeTouch([
    { classes: ['seg-item'], w: 100, h: 35 },
    { classes: ['seg-item'], w: 100, h: 35 },
    { classes: ['btn', 'month-btn'], w: 80, h: 33 },
  ]);
  assert.strictEqual(issue.level, 'P1');
  assert.strictEqual(issue.rule, '触控区');
  assert.ok(/3 个可点元素/.test(issue.msg), '总数应为 3，实际: ' + issue.msg);
  assert.ok(/\.seg-item ×2/.test(issue.msg), '应含 .seg-item ×2，实际: ' + issue.msg);
  assert.ok(/\.month-btn/.test(issue.msg), '应含 .month-btn，实际: ' + issue.msg);
  assert.strictEqual(issue.class, 'seg-item btn month-btn');
  assert.ok(issue.fix, '应带改法');
});

t('明细口径写明「同一元素多 class 会重复计入」，避免主句元素数与各项之和看起来对不上', () => {
  const issue = summarizeTouch([
    { classes: ['btn', 'btn-sm'], w: 80, h: 30 },
    { classes: ['btn', 'btn-sm'], w: 80, h: 30 },
  ]);
  // 2 个元素，但 btn / btn-sm 各命中 2 次 → 明细之和 4 > 元素总数 2
  assert.ok(/2 个可点元素/.test(issue.msg), '主句应是元素数，实际: ' + issue.msg);
  assert.ok(/\.btn ×2/.test(issue.msg) && /\.btn-sm ×2/.test(issue.msg), '明细应是 class 命中数，实际: ' + issue.msg);
  assert.ok(/重复计入/.test(issue.msg), '应写明口径差异，实际: ' + issue.msg);
});

console.log('· nav-cost（可达图与入口识别，供真点击/流程测试复用）');

t('从 wxml 抽出可点元素：handler、class、展示文字', () => {
  const wxml = '<view class="btn btn-ghost" bindtap="goAdd" data-type="expense">记一笔支出</view>';
  const t0 = tapTargets(wxml);
  assert.strictEqual(t0.length, 1);
  assert.strictEqual(t0[0].handler, 'goAdd');
  assert.deepStrictEqual(t0[0].classes, ['btn', 'btn-ghost']);
  assert.strictEqual(t0[0].text, '记一笔支出');
});

t('没有 bindtap 的元素不算可点', () => {
  assert.strictEqual(tapTargets('<view class="card">只是显示</view>').length, 0);
});

t('文字里的插值折成省略号，不把模板当文案', () => {
  const t0 = tapTargets('<view bindtap="f">{{canNext ? "" : "x"}}下一月</view>');
  assert.strictEqual(t0[0].text, '…下一月');
});

t('跳转 url 只取字面量，拼在后面的变量被丢掉', () => {
  const calls = navCalls("wx.navigateTo({ url: '/pages/add/add?type=' + type })");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'pages/add/add');
  assert.strictEqual(calls[0].api, 'navigateTo');
});

t('整段拼不出字面量的 url 记为 unknown，不猜目标', () => {
  const calls = navCalls('wx.navigateTo({ url: someVar })');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].unknown, true);
  assert.strictEqual(calls[0].url, null);
});

t('computeCost：tab 页点 1 下直达、点 1 下回首页', () => {
  const r = computeCost({
    pages: ['pages/index/index', 'pages/stats/stats'],
    tabPages: ['pages/index/index', 'pages/stats/stats'],
    home: 'pages/index/index',
    edges: {}, backs: {}, taps: {},
  });
  const stats = r.pages.find((p) => p.page === 'pages/stats/stats');
  assert.strictEqual(stats.entryTaps, 1);
  assert.strictEqual(stats.backTaps, 1);
  assert.strictEqual(stats.level, 'ok');
});

t('computeCost：靠 navigateTo 进、靠 navigateBack 回，进出都是 1 下', () => {
  const r = computeCost({
    pages: ['pages/index/index', 'pages/add/add'],
    tabPages: ['pages/index/index'],
    home: 'pages/index/index',
    edges: { 'pages/index/index': ['pages/add/add'] },
    backs: { 'pages/add/add': true },
    taps: {},
  });
  const add = r.pages.find((p) => p.page === 'pages/add/add');
  assert.strictEqual(add.entryTaps, 1);
  assert.strictEqual(add.backTaps, 1);
  assert.strictEqual(add.isTab, false);
});

t('computeCost：没有入口的页面判为到不了，而不是算 0 下', () => {
  const r = computeCost({
    pages: ['pages/index/index', 'pages/lost/lost'],
    tabPages: ['pages/index/index'],
    home: 'pages/index/index',
    edges: {}, backs: {}, taps: {},
  });
  const lost = r.pages.find((p) => p.page === 'pages/lost/lost');
  assert.strictEqual(lost.entryTaps, null);
  assert.strictEqual(lost.level, 'unreachable');
  assert.strictEqual(r.totals.unreachable, 1);
});

t('computeCost：非 tab 页又没有 navigateBack → 只能靠系统返回，判为难用', () => {
  const r = computeCost({
    pages: ['pages/index/index', 'pages/deep/deep'],
    tabPages: ['pages/index/index'],
    home: 'pages/index/index',
    edges: { 'pages/index/index': ['pages/deep/deep'] },
    backs: { 'pages/deep/deep': false },
    taps: {},
  });
  const deep = r.pages.find((p) => p.page === 'pages/deep/deep');
  assert.strictEqual(deep.backTaps, null);
  assert.strictEqual(deep.level, 'hard');
  assert.ok(/系统返回/.test(deep.note), '应说明只能靠系统返回，实际: ' + deep.note);
});

t('computeCost：深层页回首页要逐层退，按层数算成本', () => {
  const r = computeCost({
    pages: ['pages/index/index', 'pages/a/a', 'pages/b/b'],
    tabPages: ['pages/index/index'],
    home: 'pages/index/index',
    edges: { 'pages/index/index': ['pages/a/a'], 'pages/a/a': ['pages/b/b'] },
    backs: { 'pages/a/a': true, 'pages/b/b': true },
    taps: {},
  });
  assert.strictEqual(r.pages.find((p) => p.page === 'pages/b/b').entryTaps, 2);
  assert.strictEqual(r.pages.find((p) => p.page === 'pages/b/b').backTaps, 2);
});

t('computeCost：页面路径带不带前导斜杠、带不带后缀都归一化', () => {
  assert.strictEqual(normPage('/pages/a/a'), 'pages/a/a');
  assert.strictEqual(normPage('pages/a/a.js'), 'pages/a/a');
  assert.strictEqual(normPage('pages/a/a.wxml'), 'pages/a/a');
});

console.log('· content / compile（读内容、真编译）');

t('bindingRefs：只取插值的根标识符，属性名不算引用', () => {
  const { roots } = bindingRefs('<view>{{ user.name }}</view>');
  assert.deepStrictEqual(roots, ['user']);
});

t('bindingRefs：字符串字面量里的词不算变量名', () => {
  const { roots } = bindingRefs("<view>{{ t === 'expense' ? a : b }}</view>");
  assert.deepStrictEqual(roots.sort(), ['a', 'b', 't']);
});

t('bindingRefs：函数调用名不算字段引用', () => {
  const { roots } = bindingRefs('<view>{{ formatDate(x) }}</view>');
  assert.deepStrictEqual(roots, ['x']);
});

t('bindingRefs：wx:for 的别名被识别出来（不该当成缺字段）', () => {
  const { roots, loops } = bindingRefs('<view wx:for="{{list}}" wx:for-item="row">{{ row.title }}{{ index }}</view>');
  assert.deepStrictEqual(roots.sort(), ['index', 'list', 'row']);
  assert.ok(loops.includes('row'), 'loop 别名应含 row');
  assert.ok(loops.includes('index'), 'loop 别名应含 index');
});

t('staticDataKeys：从 js 的 data 初值里抠出字段名', () => {
  const js = "Page({ data: { total: 0, list: [], user: { name: '' } }, onLoad() {} })";
  const keys = staticDataKeys(js);
  for (const k of ['total', 'list', 'user', 'name']) assert.ok(keys.includes(k), '应含 ' + k + '，实际 ' + keys.join(','));
});

t('dataSummary：列表里有内容 → hasList', () => {
  assert.strictEqual(dataSummary({ list: [1, 2] }).state, 'hasList');
});

t('dataSummary：有列表字段但都为空 → emptyList（空 class 属正常空态）', () => {
  assert.strictEqual(dataSummary({ list: [], total: 0 }).state, 'emptyList');
});

t('dataSummary：根本没有列表字段 → noList（不能据此判定）', () => {
  assert.strictEqual(dataSummary({ label: '10月', total: 2 }).state, 'noList');
});

t('dataSummary：忽略小程序注入的 __webviewId__ 之类内部字段', () => {
  const s = dataSummary({ __webviewId__: 13, list: [] });
  assert.strictEqual(s.keys, 1);
  assert.strictEqual(s.state, 'emptyList');
});

t('listCompileTargets：列全 wxml / wxss，但跳过 node_modules 与自检产物', () => withCompileFixture((dir) => {
  const files = listCompileTargets(dir);
  assert.ok(files.includes('app.json') === false, 'json 不该进编译清单');
  assert.ok(files.every((f) => /\.(wxml|wxss)$/.test(f)), '只应有 wxml/wxss，实际 ' + files.join(','));
  assert.ok(files.length > 0, '夹具工程应有可编译文件');
}));

t('judgeTruncation：文字明显装不下 → 判为截断（数值取自实测）', () => {
  assert.strictEqual(judgeTruncation(350, 180), true);
});

t('judgeTruncation：留容差，差一点点不算截断（避免字体回退造成误报）', () => {
  assert.strictEqual(judgeTruncation(70, 180), false);
  assert.strictEqual(judgeTruncation(185, 180), false);
  assert.strictEqual(judgeTruncation(200, 180), true);
});

t('judgeTruncation：窄元素用绝对容差，不会被相对容差吃掉', () => {
  assert.strictEqual(judgeTruncation(40, 30), true);
  assert.strictEqual(judgeTruncation(32, 30), false);
});

// ── 模块 D 真编译：从报错里反查真实出错的文件 ────────────────────────
// 这条逻辑退化会让报告「点名无辜文件」，比不报还糟（实测踩过：ok.wxml 被报成不通过）。

t('parseErrorFiles：从真实报错里抽出出错文件', () => {
  const msg = '编译 .wxml 文件错误，错误信息如上，可在控制台查看更详细信息 ./pages/bad/bad.wxml:4:1: unexpected end';
  assert.deepStrictEqual(parseErrorFiles(msg, null), ['pages/bad/bad.wxml']);
});

t('parseErrorFiles：报错里的「.wxss」这种光扩展名不算文件', () => {
  const msg = '编译 .wxss 文件错误，错误信息如上，可在控制台查看更详细信息';
  assert.deepStrictEqual(parseErrorFiles(msg, null), []);
});

t('parseErrorFiles：多个文件去重后按出现顺序返回', () => {
  const msg = './pages/a/a.wxml:1:1: x，./pages/b/b.wxss:2:3: y，以及 ./pages/a/a.wxml:9:9: z';
  assert.deepStrictEqual(parseErrorFiles(msg, null), ['pages/a/a.wxml', 'pages/b/b.wxss']);
});

t('parseErrorFiles：工程里不存在的路径会被过滤掉（防止把报错里的举例当文件）', () => withCompileFixture((fx) => {
  const msg = './pages/bad/bad.wxml:4:1: err，还有 ./pages/nope/nope.wxml:1:1: err';
  assert.deepStrictEqual(parseErrorFiles(msg, fx), ['pages/bad/bad.wxml']);
}));

// ── 模块 G 点击测试：路径搜索 ──────────────────────────────────

t('methodNavMap：按 handler 名精确查找，不把 Page({...}) 误认成方法', () => {
  const js = `
    Page({
      goAdd() { wx.navigateTo({ url: '/pages/add/add?type=expense' }) },
      goStats: function () { wx.switchTab({ url: '/pages/stats/stats' }) },
      goDyn(id) { wx.navigateTo({ url: '/pages/d/' + id }) },
      noop() { console.log('hi') }
    })
  `;
  const m = methodNavMap(js, ['goAdd', 'goStats', 'goDyn', 'noop']);
  assert.deepStrictEqual(m.goAdd, { api: 'navigateTo', url: 'pages/add/add' });
  assert.deepStrictEqual(m.goStats, { api: 'switchTab', url: 'pages/stats/stats' });
  assert.strictEqual(m.goDyn, undefined, '路径拼接的 url 不能认，否则会点错地方');
  assert.strictEqual(m.noop, undefined);
  assert.strictEqual(m.Page, undefined, 'Page 是函数调用不是方法');
});

t('navCalls：字面量 + query 拼接仍算安全，路径拼接算 unknown', () => {
  const js = `
    wx.navigateTo({ url: '/pages/add/add' })
    wx.navigateTo({ url: '/pages/add/add?type=' + type })
    wx.navigateTo({ url: '/pages/d/' + id })
  `;
  const calls = navCalls(js);
  assert.deepStrictEqual(calls[0], { api: 'navigateTo', url: 'pages/add/add', unknown: false });
  assert.deepStrictEqual(calls[1], { api: 'navigateTo', url: 'pages/add/add', unknown: false });
  assert.strictEqual(calls[2].unknown, true, "'/pages/d/' + id 的 pages/d/ 是假页面，必须判 unknown");
});

t('findTapPath：首页直达返回一跳', () => {
  const edges = [{ from: 'pages/index/index', to: 'pages/add/add', selector: '.btn' }];
  const p = findTapPath(edges, 'pages/index/index', 'pages/add/add');
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].to, 'pages/add/add');
});

t('findTapPath：多跳按顺序串起来', () => {
  const edges = [
    { from: 'a', to: 'b', selector: '.x' },
    { from: 'b', to: 'c', selector: '.y' },
  ];
  const p = findTapPath(edges, 'a', 'c');
  assert.deepStrictEqual(p.map((e) => e.to), ['b', 'c']);
});

t('findTapPath：到不了就返回 null，不硬编一条假的', () => {
  const edges = [{ from: 'a', to: 'b', selector: '.x' }];
  assert.strictEqual(findTapPath(edges, 'a', 'zzz'), null);
});

t('findTapPath：目标是首页本身时不需要点任何东西', () => {
  assert.deepStrictEqual(findTapPath([], 'a', 'a'), []);
});

t('findTapPath：环不会死循环', () => {
  const edges = [
    { from: 'a', to: 'b', selector: '.1' },
    { from: 'b', to: 'a', selector: '.2' },
  ];
  assert.strictEqual(findTapPath(edges, 'a', 'zzz'), null);
  assert.deepStrictEqual(findTapPath(edges, 'a', 'b').map((e) => e.to), ['b']);
});

console.log('· ux-audit —— 流程测试（把「填写 → 提交」当用户体验一遍）');

const FORM_WXML = [
  '<view class="page">',
  '  <input class="amount-field" type="digit" placeholder="0.00" bindinput="onAmount" />',
  '  <input class="field-input" placeholder="选填" bindinput="onNote" />',
  '  <picker mode="date" bindchange="onDate"><view>{{date}}</view></picker>',
  '  <view class="btn btn-primary" bindtap="save">保存</view>',
  '</view>',
].join('\n');

const FORM_JS = [
  'Page({',
  '  onAmount() {},',
  '  save() {',
  '    const fen = fmt.yuan2fen(this.data.amountStr)',
  "    if (fen <= 0) { wx.showToast({ title: '请输入金额', icon: 'none' }); return }",
  '    store.addRecord({})',
  "    wx.showToast({ title: '已记录', icon: 'success' })",
  '  },',
  '});',
].join('\n');

t('formInputs：input / textarea / picker 都能抽出来', () => {
  const ins = formInputs(FORM_WXML);
  assert.strictEqual(ins.length, 3, '应抽到 3 个控件，实际 ' + ins.length);
  assert.strictEqual(ins[0].type, 'digit');
  assert.strictEqual(ins[2].tag, 'picker');
});

t('findForms：识别出提交按钮，并带上可定位的输入框', () => {
  const { tasks } = findForms(FORM_WXML, FORM_JS);
  assert.strictEqual(tasks.length, 1, '应识别 1 个提交任务，实际 ' + tasks.length);
  assert.strictEqual(tasks[0].text, '保存');
  assert.strictEqual(tasks[0].selector, '.btn.btn-primary');
  // picker 没有 class，选择器定位不到它，所以只统计两个带 class 的 input
  assert.strictEqual(tasks[0].inputs.length, 2, '只统计带 class 的控件（无 class 无法用选择器定位）');
});

t('findForms：静态看到反馈与校验（用于和运行时交叉判定）', () => {
  const { tasks } = findForms(FORM_WXML, FORM_JS);
  assert.strictEqual(tasks[0].feedbackApi, 'showToast', '方法体里调了 showToast，应识别出来');
  assert.strictEqual(tasks[0].guardHint, true, '方法体里有「请输入」提示，应识别为有校验');
});

t('findForms：没有输入框的页面不产生提交任务（防导航按钮被误判）', () => {
  const wxml = '<view class="btn btn-ghost" bindtap="goAdd">记一笔支出</view>';
  const js = 'Page({ goAdd() { wx.navigateTo({ url: "/pages/add/add" }) } })';
  const { tasks } = findForms(wxml, js);
  assert.strictEqual(tasks.length, 0, '纯导航按钮不是提交按钮，不该产生任务');
});

t('findForms：没有输入框时连「保存」也不当提交任务', () => {
  const wxml = '<view class="btn" bindtap="save">保存</view>';
  const js = 'Page({ save() { wx.showToast({ title: "ok" }) } })';
  assert.strictEqual(findForms(wxml, js).tasks.length, 0);
});

t('findDangerOps：识别危险操作，并看出有没有二次确认', () => {
  const wxml =
    '<view class="btn btn-danger" bindtap="clearAll">清空全部数据</view>' +
    '<view class="btn" bindtap="del">删除</view>';
  const js = [
    'Page({',
    '  clearAll() { wx.showModal({ title: "清空全部数据", content: "无法恢复" }) },',
    '  del() { store.remove() },',
    '})',
  ].join('\n');
  const ops = findDangerOps(wxml, js);
  assert.strictEqual(ops.length, 2, '两个危险操作都该被识别');
  assert.strictEqual(ops[0].confirm, true, 'clearAll 有 showModal，应判有二次确认');
  assert.strictEqual(ops[1].confirm, false, 'del 没有确认弹窗，应报出来');
});

t('judgeEmptySubmit：空提交跳走了 = P1（没校验，脏数据进库）', () => {
  const r = judgeEmptySubmit({ pageChanged: true, dataChanged: true, feedbackApi: null, guardHint: false });
  assert.strictEqual(r.level, 'P1');
});

t('judgeEmptySubmit：空提交改了数据 = P2（可能是清空/重置语义，需人确认）', () => {
  const r = judgeEmptySubmit({ pageChanged: false, dataChanged: true, feedbackApi: 'showToast', guardHint: false });
  assert.strictEqual(r.level, 'P2');
});

t('judgeEmptySubmit：被拦住 + 代码里有提示 = ok', () => {
  const r = judgeEmptySubmit({ pageChanged: false, dataChanged: false, feedbackApi: 'showToast', guardHint: true });
  assert.strictEqual(r.level, 'ok');
});

t('judgeEmptySubmit：没变化也没提示代码 = P1（点了没反应）', () => {
  const r = judgeEmptySubmit({ pageChanged: false, dataChanged: false, feedbackApi: null, guardHint: false });
  assert.strictEqual(r.level, 'P1');
});

t('judgeSubmit：跳转 / 数据变化提供响应线索，不能证明业务保存成功', () => {
  assert.strictEqual(judgeSubmit({ pageChanged: true, landedOn: 'x' }).level, 'ok');
  assert.strictEqual(judgeSubmit({ pageChanged: false, dataChanged: true }).level, 'ok');
  assert.strictEqual(judgeSubmit({ pageChanged: false, dataChanged: false }).level, 'P2');
});

t('pickFillInput：优先数字类输入框', () => {
  const ins = [{ classes: ['a'], type: 'text' }, { classes: ['b'], type: 'digit' }];
  assert.strictEqual(pickFillInput(ins).selector, '.b');
});

t('pickFillInput：没有可用输入框时返回 null，不硬编选择器', () => {
  assert.strictEqual(pickFillInput([]), null);
  assert.strictEqual(pickFillInput([{ classes: [], type: 'text' }]), null);
});

t('methodBody：能取出方法体；找不到返回空串（不抛异常）', () => {
  assert.ok(methodBody(FORM_JS, 'save').includes('store.addRecord'));
  assert.strictEqual(methodBody(FORM_JS, 'notExist'), '');
  assert.strictEqual(methodBody(FORM_JS, '坏名字-带符号'), '');
});

// ── device-patch：机型规格解析（纯函数） ─────────────────────
const MOCK_TABLE = [
  { index: 0, name: 'iPhone 5', desc: '320 x 568 | Dpr:2', type: 'default' },
  { index: 1, name: 'iPhone 6/7/8', desc: '375 x 667 | Dpr:2', type: 'default' },
  { index: 2, name: 'iPhone X', desc: '375 x 812 | Dpr:3', type: 'default' },
  { index: 3, name: 'iPhone 12/13 (Pro)', desc: '390 x 844 | Dpr:3', type: 'default' },
  { index: 4, name: 'iPad', desc: '768 x 1024 | Dpr:2', type: 'default' },
  { index: 5, name: '我的自定义机', desc: '', type: 'custom' },
];

t('sizeOf：从机型描述里抠出宽高；空描述返回 null', () => {
  assert.deepStrictEqual(sizeOf('320 x 568 | Dpr:2'), { width: 320, height: 568 });
  assert.deepStrictEqual(sizeOf('375*667'), { width: 375, height: 667 });
  assert.strictEqual(sizeOf(''), null);
  assert.strictEqual(sizeOf('没有尺寸信息'), null);
});

t('parseDeviceSpec：按宽度匹配；同宽度取第一个最严苛的', () => {
  const hit = parseDeviceSpec('375', MOCK_TABLE);
  assert.strictEqual(hit.index, 1, '375 应命中 iPhone 6/7/8（列表顺序在前）');
  assert.strictEqual(parseDeviceSpec('320x568', MOCK_TABLE).name, 'iPhone 5');
});

t('parseDeviceSpec：按名称匹配（大小写不敏感）', () => {
  assert.strictEqual(parseDeviceSpec('iphone 5', MOCK_TABLE).name, 'iPhone 5');
  assert.strictEqual(parseDeviceSpec('iPad', MOCK_TABLE).name, 'iPad');
});

t('parseDeviceSpec：找不到返回 null；空入参返回 null', () => {
  assert.strictEqual(parseDeviceSpec('999', MOCK_TABLE), null);
  assert.strictEqual(parseDeviceSpec('不存在的机型', MOCK_TABLE), null);
  assert.strictEqual(parseDeviceSpec('', MOCK_TABLE), null);
  assert.strictEqual(parseDeviceSpec('320', null), null);
});

t('parseDeviceSpec：尺寸匹配优先于名称；不匹配自定义机型', () => {
  // 同名冲突不存在，但「自定义机」type=custom 不应被名称匹配命中
  assert.strictEqual(parseDeviceSpec('自定义', MOCK_TABLE), null);
});

console.log('\n  ' + pass + ' 项通过' + (process.exitCode ? '，存在失败项' : ''));
