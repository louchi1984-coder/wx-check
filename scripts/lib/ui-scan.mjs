/**
 * UI几何与截图采集（需要开发者工具已打开项目且已登录）
 *
 * 自动读 app.json 得到全部页面（含分包）→ 逐页导航 → 静态提取 wxml 中的 class →
 * 运行时整页采集 class 矩形 → 按几何规则判定客观缺陷。
 *
 * 不依赖任何项目专属的页面路径、类名或选择器。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { wechatide } from './wechatide.mjs';
import { assertPageSnapshot } from './page-context.mjs';

const TOUCH_MIN = 44;
const R = (n) => Math.round(Number(n) * 10) / 10;

function readAppJson(project) {
  return JSON.parse(fs.readFileSync(path.join(project, 'app.json'), 'utf8'));
}

function listPages(app) {
  const pages = [...(app.pages || [])];
  for (const sp of app.subPackages || app.subpackages || []) {
    const root = String(sp.root || '').replace(/\/$/, '');
    for (const p of sp.pages || []) pages.push(root + '/' + String(p).replace(/^\//, ''));
  }
  return pages.map((p) => p.replace(/^\//, '')).filter(Boolean);
}

const tabPages = (app) => ((app.tabBar && app.tabBar.list) || []).map((i) => String(i.pagePath || '').replace(/^\//, ''));

function classesIn(s) {
  const out = [];
  for (const m of String(s).matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (/^[A-Za-z0-9_-]+$/.test(c)) out.push(c);
  }
  return out;
}

const readWxml = (project, page) => {
  const f = path.join(project, page + '.wxml');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};

/** 静态找「可点元素」的 class：带 bindtap / catchtap / bind:tap 的标签 */
function tapClasses(wxml) {
  const s = new Set();
  for (const m of String(wxml).matchAll(/<([a-zA-Z][\w-]*)([^>]*?)\/?>/g)) {
    if (/\b(?:bind|catch):?tap\b/.test(m[2])) for (const c of classesIn(m[2])) s.add(c);
  }
  return [...s];
}

/** 整页一次采集；只读 boundingClientRect，避免 fields 的序列化问题。 */
async function pageSnapshot(run, classes) {
  const fn = 'function(){return new Promise(function(resolve){' +
    'var ps=getCurrentPages();var p=ps[ps.length-1];var q=wx.createSelectorQuery().in(p);' +
    'var cs=' + JSON.stringify(classes) + ';' +
    'cs.forEach(function(c){q.selectAll("."+c).boundingClientRect();});' +
    'q.exec(function(r){resolve({route:p.route,nativeId:p.__wxWebviewId__||p.data.__webviewId__,window:wx.getWindowInfo(),rects:r});});});}';
  return (await run('automation_evaluate', ['--fn-source', fn])).result?.result?.result;
}

/**
 * 把「按 class 查到的矩形」还原成「按元素」。
 *
 * 同一个 rect 出现在多个 class 的查询结果里，就说明这个元素同时挂了这些 class。
 * 为什么必须还原：上报的 class 名决定用户去哪儿改样式。
 * 典型翻车：`class="btn btn-ghost month-btn"` 的月份切换按钮，高度实际由 `.month-btn`
 * 决定，但查询按 class 顺序先命中 `.btn`，直接报 `.btn` 会把用户引去改一个本来就达标的
 * 类 —— 报了等于没报。所以要报就报元素**真实挂载的全部 class**。
 */
// 这两个是纯函数，导出只为让离线回归能直接喂假数据验证（不依赖模拟器）
export function groupByElement(rects) {
  const map = new Map();
  for (const [cls, els] of Object.entries(rects)) {
    for (const el of els) {
      if (!el) continue;
      const key = [el.left, el.top, el.right, el.bottom].join(',');
      let g = map.get(key);
      if (!g) {
        g = { el, classes: [] };
        map.set(key, g);
      }
      if (!g.classes.includes(cls)) g.classes.push(cls);
    }
  }
  return [...map.values()];
}

export function checkPage(rects, taps, vw) {
  const issues = [];
  const touchSmall = [];
  const add = (level, rule, cls, msg) => issues.push({ level, rule, class: cls, msg });
  // 零尺寸（宽高都是 0）等于不可见元素：既不参与判定，也不计入元素数 ——
  // 保持与按矩形去重的原语义一致，别让重写顺手改变报告里的数字口径。
  const els = groupByElement(rects).filter(
    ({ el }) => (Number(el.width) || 0) > 0 || (Number(el.height) || 0) > 0
  );

  for (const { el, classes } of els) {
    const w = Number(el.width) || 0;
    const h = Number(el.height) || 0;
    const l = Number(el.left) || 0;
    const r = Number(el.right) || 0;

    // 报真实 class 组合（按 wxml 里的书写顺序），而不是碰巧先匹配上的那一个
    const label = classes.join(' ');

    if (r > vw + 1) add('P0', '横向溢出', label, '右边界 ' + R(r) + ' 超出屏幕宽 ' + vw);
    if (l < -1) add('P0', '横向溢出', label, '左边界 ' + R(l) + ' 在屏幕外');

    const tapCls = classes.filter((c) => taps.includes(c));
    if (tapCls.length && (w < TOUCH_MIN || h < TOUCH_MIN)) touchSmall.push({ classes: tapCls, w, h });
  }

  return { issues, uniq: els.length, touchSmall };
}

/**
 * 把跨页收集到的触控区命中聚合成**一条**模块级结论（没有命中则返回 null）。
 *
 * 聚合而不是逐页报，是为了让「合计 P1」与明细条数对得上 —— 同一类问题被数好几遍
 * 是报告最容易失去信任的地方。
 */
export function summarizeTouch(touchAll) {
  if (!touchAll || !touchAll.length) return null;
  const byCls = new Map();
  for (const t of touchAll) for (const c of t.classes) byCls.set(c, (byCls.get(c) || 0) + 1);
  const detail = [...byCls.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([c, n]) => '.' + c + (n > 1 ? ' ×' + n : ''))
    .join('、');
  return {
    level: 'P1',
    rule: '触控区',
    class: [...byCls.keys()].join(' '),
    msg:
      touchAll.length + ' 个可点元素小于 ' + TOUCH_MIN + '×' + TOUCH_MIN + '，命中的 class：' + detail +
      '（×N 是该 class 命中的元素数；同一元素挂多个 class 会重复计入，故各项之和大于元素总数。无障碍优化项，可忽略）',
    fix: '要达标就把对应 class 的高度提到 ≥ ' + TOUCH_MIN + 'px（375 设计稿约 88rpx）；元素若挂了多个 class，高度由更具体的那个决定',
  };
}

/** 单尺寸 UI 检测。精测增加一次布局稳定性核对；不重复编译或刷新。 */
export async function scanUI(project, opts = {}) {
  const { only = '', bin = null, log = () => {}, screenshot = false,
    mode = 'minimal', expectedSize = null, pageData = {}, call = wechatide } = opts;
  if (!['minimal', 'precise'].includes(mode)) throw new Error('mode 必须为 minimal 或 precise');
  const app = readAppJson(project);
  const pages = listPages(app).filter(p => !only || p === only);
  if (!pages.length) throw new Error('未找到匹配的页面: ' + only);
  const tabs = tabPages(app);
  const timings = [];
  /**
   * automator 在 simulator_refresh 之后会有一段不可用窗口（重编译中），
   * 此时 IDE 侧直接回 "timeout waiting for automator response" —— 加大调用方超时没有用，
   * 因为这个错误是 IDE 自己按内部超时返回的。命中后等重编译结束再重试一次。
   */
  const AUTOMATOR_DEAD = /timeout waiting for automator response/i;
  const settle = opts.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));
  let recovered = false;

  const dead = (v) => AUTOMATOR_DEAD.test(String(v?.message ?? v));

  /** 单次尝试：无论是抛异常还是返回 ok:false，都统一成「结果 + 错误信息」。 */
  async function attempt(tool, args) {
    let r = null;
    let err = null;
    try {
      r = await call(tool, ['--project', project, ...args], { bin, timeout: 45000 });
    } catch (e) {
      err = String(e?.message || e);
    }
    if (!err && (!r || r.ok === false || r.result?.success === false)) {
      err = String(r?.message || r?.result?.error || '调用未成功');
    }
    return { r, err };
  }

  async function run(tool, args) {
    const start = Date.now();
    let r = null;
    try {
      let { r: res, err } = await attempt(tool, args);
      if (err && dead(err) && !recovered && tool.startsWith('automation_')) {
        recovered = true;
        log('  automator 忙（重编译中），等待 20 秒后重试一次');
        await settle(20000);
        ({ r: res, err } = await attempt(tool, args));
      }
      if (err) throw new Error(err);
      r = res;
      return r;
    } finally {
      timings.push({ tool, ms: Date.now() - start, ok: !!r && r.ok !== false && r.result?.success !== false });
    }
  }
  async function windowInfo() {
    const r = await run('automation_evaluate', ['--fn-source',
      'function(){var ps=getCurrentPages();return {window:wx.getWindowInfo(),device:wx.getDeviceInfo(),route:ps[ps.length-1].route};}']);
    const info = r.result?.result?.result;
    const w = info?.window;
    if (!(w?.windowWidth > 0 && w?.windowHeight > 0)) throw new Error('实际视口采集失败');
    if (expectedSize && (w.screenWidth !== expectedSize.width || w.screenHeight !== expectedSize.height)) {
      throw new Error('机型尚未切到目标尺寸 ' + expectedSize.width + '×' + expectedSize.height);
    }
    return info;
  }
  // 两次真实尺寸一致才开始；无默认值、固定长等待或刷新。
  const first = opts.readyInfo || await windowInfo();
  const info = opts.readyInfo || await windowInfo();
  if (!(info.window?.windowWidth > 0 && info.window?.windowHeight > 0) ||
      (expectedSize && (info.window.screenWidth !== expectedSize.width || info.window.screenHeight !== expectedSize.height))) {
    throw new Error('就绪信息与目标尺寸不符');
  }
  const sameWindow = (a, b) => ['windowWidth', 'windowHeight', 'screenWidth', 'screenHeight', 'pixelRatio']
    .every(k => a?.[k] === b?.[k]);
  if (!sameWindow(first.window, info.window)) throw new Error('尺寸仍在变化，本轮不开始采集');
  const vw = info.window.windowWidth;
  const report = { viewport: { width: vw, height: info.window.windowHeight },
    screen: { width: info.window.screenWidth, height: info.window.screenHeight },
    device: info.device, mode, pages: [], issues: [], totals: { P0: 0, P1: 0 },
    elements: 0, failedClasses: [], emptyClasses: {}, dataState: {}, timings,
    coverage: { visualReview: '未读图，仅完成采集', geometry: '横向溢出、触控区', overlap: '未自动判定', truncation: '未自动判定',
      scrolling: '未执行', keyboard: '未执行', data: '当前页面数据，未注入测试数据' } };
  const shotDir = path.resolve(opts.screenshotDir || path.join(os.tmpdir(), 'miniprogram-ui-' + process.pid + '-' + Date.now()));
  const relativeShotDir = path.relative(path.resolve(project), shotDir);
  if (!relativeShotDir || (!relativeShotDir.startsWith('..' + path.sep) && !path.isAbsolute(relativeShotDir))) {
    throw new Error('截图目录必须在被测工程之外，避免触发热重载');
  }
  const touchAll = [];
  for (const page of pages) {
    const wxml = readWxml(project, page);
    const classes = [...new Set(classesIn(wxml))];
    const taps = tapClasses(wxml);
    let entry;
    try {
      await run('automation_navigate', ['--action', tabs.includes(page) ? 'switchTab' : 'reLaunch', '--url', '/' + page]);
      async function collect() {
        const data = await pageSnapshot(run, classes);
        const context = assertPageSnapshot(data, await run('automation_runtime_info', ['--action', 'currentPage']));
        if (data?.route !== page) throw new Error('当前页面与目标不一致');
        if (!['screenWidth', 'screenHeight', 'pixelRatio', 'windowWidth'].every(k => data.window?.[k] === info.window[k])) {
          throw new Error('检测中途屏幕尺寸改变');
        }
        if (!Array.isArray(data.rects) || data.rects.length !== classes.length || data.rects.some(x => !Array.isArray(x))) {
          throw new Error('页面元素采集不完整');
        }
        return { rects: Object.fromEntries(classes.map((c, i) => [c, data.rects[i]])), window: data.window, context };
      }
      let snapshot = await collect();
      let layoutSamples = 1;
      if (mode === 'precise') {
        const signature = r => JSON.stringify(groupByElement(r).map(({el,classes}) =>
          [classes, el.left, el.top, el.right, el.bottom]));
        const deadline = Date.now() + 2000;
        let stable = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          await settle(100);
          const second = await collect();
          layoutSamples++;
          stable = sameWindow(snapshot.window, second.window) && signature(snapshot.rects) === signature(second.rects);
          snapshot = second;
          if (stable || Date.now() >= deadline) break;
        }
        if (!stable) throw new Error('布局在2秒稳定等待内仍变化，需要稍后重测');
      }
      const rects = snapshot.rects;
      const checked = checkPage(rects, taps, vw);
      if (!checked.uniq) throw new Error('没有采集到可见元素，不能判为通过');
      entry = { page, classes: classes.length, elements: checked.uniq, issues: checked.issues,
        viewport: { width: snapshot.window.windowWidth, height: snapshot.window.windowHeight },
        touchSmall: checked.touchSmall, rects, dataState: pageData[page]?.state || 'unknown' };
      entry.context = snapshot.context;
      entry.layoutSamples = layoutSamples;
      report.elements += checked.uniq;
      touchAll.push(...checked.touchSmall);
      report.emptyClasses[page] = classes.filter(c => !rects[c].length).length;
      report.dataState[page] = entry.dataState;
      report.totals.P0 += checked.issues.filter(i => i.level === 'P0').length;
      report.totals.P1 += checked.issues.filter(i => i.level === 'P1').length;
      log('  ' + page + ': ' + checked.uniq + ' 个元素');
    } catch (e) {
      entry = { page, error: e.message, issues: [] };
      report.incomplete = true;
      report.aborted = true;
      log('  停止采集：' + e.message);
    }
    report.pages.push(entry);
    // 精测每页保留一次界面证据；其余机型异常才截图。
    if (mode === 'precise' || screenshot || entry.error || entry.issues.length) {
      fs.mkdirSync(shotDir, { recursive: true });
      try {
        const file = path.join(shotDir, page.replace(/\//g, '_') + '.png');
        if (entry.error) throw Error('页面核对或采集失败，未将截图作为该页证据');
        assertPageSnapshot({ nativeId: entry.context.nativeId, route: page }, await run('automation_runtime_info', ['--action', 'currentPage']));
        await run('simulator_screenshot', ['--path', file]);
        entry.screenshot = file;
      } catch (e) { entry.screenshotError = e.message; }
    }
    if (report.aborted) break;
  }
  report.unvisitedPages = pages.slice(report.pages.length);
  const touchIssue = summarizeTouch(touchAll);
  if (touchIssue) { report.issues.push(touchIssue); report.totals.P1++; }
  if (opts.restorePage === false) {
    report.restorationDeferred = true;
  } else if (first.route && !report.aborted && report.pages.at(-1)?.page === first.route) {
    report.restored = true;
  } else if (first.route && !report.aborted) {
    try {
      await run('automation_navigate', ['--action', tabs.includes(first.route) ? 'switchTab' : 'reLaunch', '--url', '/' + first.route]);
      const restored = await pageSnapshot(run, []);
      assertPageSnapshot(restored, await run('automation_runtime_info', ['--action', 'currentPage']));
      report.restored = restored?.route === first.route;
      if (!report.restored) report.restoreError = '结束后页面未回到原页面';
    } catch (e) { report.restored = false; report.restoreError = e.message; }
  } else { report.restored = false; report.restoreError = '采集中止或原页面未知，未自动恢复'; }
  return report;
}
