/**
 * 点击测试 —— 真正的点击逻辑
 *
 * 为什么需要它：静态推算只说「点 1 下能进 add 页」，
 * 那只是从代码里读出来的意图，按钮是不是真的能点进去、点了有没有反应，静态看不出来。
 * 本模块真的去点，再用 currentPage 验证，把「推算」变成「实测」。
 *
 * 安全边界（很重要，别放宽）：
 *   ① 只点**静态能确定会跳转**的元素（来自 nav-cost 的 edgeDetails：wxml 的 bindtap
 *      能对上 js 里某个方法、且该方法体里有字面量 url 的导航调用）。
 *      绝不点其他元素——工程里可能有「清空全部数据」这类按钮，乱点就是破坏。
 *   ② 每次验证前先回到首页（automation_navigate），保证同一个起点、结果可比较。
 *   ③ 只验证「进入」，不深入页面内部再点，不动用户数据。
 *
 * 实测返回结构（v0.3.11）：
 *   automation_runtime_info --action currentPage → result.currentPage.path
 *   automation_runtime_info --action pageStack   → result.pageStack[].path（从下到上）
 *   automation_element_action --action tap --selector .a.b → result.success（真实触发点击）
 *
 * ★★ 两条踩过的坑，别改回去 ★★
 *   1. 复位**不要**在 automation_evaluate 里执行 `wx.reLaunch` —— 实测会把调用挂死，
 *      整轮再无输出。要用官方的 `automation_navigate`。
 *   2. 这里用**同步**调用（wechatide），不用异步版：实测只有「独立进程 + 同步调用」
 *      这一种组合能稳定跑通；同一段调用放进长流程或换成异步就无响应，
 *      并且此时连兜底定时器都触发不了（事件循环被同步调用占住）。详见 SKILL.md。
 */
import { wechatide, sleep } from './wechatide.mjs';

/**
 * 复位到首页。
 * 首页是 tabBar 页面时用 switchTab，否则用 reLaunch（switchTab 到非 tab 页会失败）。
 */
function navigateReset(project, bin, page, isTab) {
  try {
    const r = wechatide(
      'automation_navigate',
      ['--project', project, '--action', isTab ? 'switchTab' : 'reLaunch', '--url', '/' + page, '--wait', '1.5'],
      { bin, timeout: 45000 }
    );
    return !!(r && r.result && r.result.success !== false);
  } catch {
    return false;
  }
}

/** 当前页路径（失败返回 null，调用方必须区分「拿不到」和「不在预期页」） */
export function currentPage(project, bin) {
  try {
    const r = wechatide('automation_runtime_info', ['--project', project, '--action', 'currentPage'], {
      bin,
      timeout: 45000,
    });
    const cp = r && r.result && r.result.currentPage;
    return cp && cp.path ? cp.path : null;
  } catch {
    return null;
  }
}

/** 页面栈（从下到上） */
export function pageStack(project, bin) {
  try {
    const r = wechatide('automation_runtime_info', ['--project', project, '--action', 'pageStack'], {
      bin,
      timeout: 45000,
    });
    const ps = r && r.result && r.result.pageStack;
    return Array.isArray(ps) ? ps.map((p) => ({ path: p.path, title: p.title || '' })) : [];
  } catch {
    return [];
  }
}

export function tapElement(project, bin, selector, call = wechatide) {
  try {
    const found = call('automation_page_action', ['--project', project, '--action', 'querySelectorAll', '--selector', selector], { bin, timeout: 45000 });
    const elements = found?.result?.elements;
    if (found?.ok === false || !Array.isArray(elements)) return { ok: false, skipped: '无法读取元素，不能判断按钮失效' };
    if (elements.length !== 1) return { ok: false, skipped: elements.length === 0 ? '按钮尚未出现，需要完成条件操作后补测' : '元素不唯一，需要明确目标后补测' };
    const r = call('automation_element_action', ['--project', project, '--action', 'tap', '--selector', selector], { bin, timeout: 45000 });
    return { ok: !!r && r.ok !== false && r.result?.success === true };
  } catch (e) { return { ok: false, skipped: '工具调用失败，未获得按钮结果：' + e.message }; }
}

/**
 * 纯函数：在「点击边」上做 BFS，找出从首页到目标页的一条点击路径。
 * 找不到返回 null（说明静态分析本身也到不了）。
 *
 * @param {Array<{from:string,to:string,selector:string,text?:string}>} edges
 * @param {string} home
 * @param {string} target
 * @returns {Array|null} 边的数组（按点击顺序）
 */
export function findTapPath(edges, home, target) {
  if (home === target) return [];
  const byFrom = {};
  for (const e of edges) {
    if (!e.from || !e.to || !e.selector) continue;
    (byFrom[e.from] = byFrom[e.from] || []).push(e);
  }
  const prev = { [home]: null };
  const q = [home];
  while (q.length) {
    const cur = q.shift();
    for (const e of byFrom[cur] || []) {
      if (prev[e.to] !== undefined) continue;
      prev[e.to] = { from: cur, edge: e };
      if (e.to === target) {
        const path = [];
        let n = target;
        while (prev[n]) {
          path.unshift(prev[n].edge);
          n = prev[n].from;
        }
        return path;
      }
      q.push(e.to);
    }
  }
  return null;
}

/**
 * 真的点一遍，逐页验证进入路径。
 *
 * @param {string} project
 * @param {Array} edgeDetails nav-cost 产出的跳转入口
 * @param {string|null} bin
 * @param {Function} log
 * @param {{home?:string, settle?:number, maxTargets?:number, tabPages?:string[]}} opts
 */
export function auditTap(project, edgeDetails, bin, log = () => {}, opts = {}) {
  const { home = '', settle = 1.8, maxTargets = Infinity, tabPages = [] } = opts;
  const tabs = new Set(
    (tabPages || []).map((t) => String(t).replace(/^\//, '').replace(/\.(js|wxml|wxss|json)$/, ''))
  );
  const homeIsTab = tabs.has(home);

  const edges = (edgeDetails || [])
    .filter((e) => e.classes && e.classes.length && e.to && e.from)
    .map((e) => ({
      from: e.from,
      to: e.to,
      selector: '.' + e.classes.join('.'),
      text: e.text || e.handler,
      handler: e.handler,
      api: e.api,
    }));

  const targets = [...new Set(edges.map((e) => e.to))].filter((t) => t !== home).slice(0, maxTargets);

  const hops = [];
  const issues = [];
  const stats = { targets: targets.length, verified: 0, failed: 0, skipped: 0, resetFailed: false };

  for (const t of targets) {
    const path = findTapPath(edges, home, t);
    if (!path || !path.length) {
      stats.skipped++;
      hops.push({ to: t, skipped: '静态分析里也没有从首页点到它的路径' });
      continue;
    }

    log('  · 验证能否进入 ' + t + '（' + path.length + ' 跳）');

    // 复位到首页，保证每次从同一起点量。外部工具偶发无响应，所以重试一次再放弃。
    log('    复位到首页…');
    let resetOk = navigateReset(project, bin, home, homeIsTab);
    if (!resetOk) {
      log('      复位无响应，重试一次…');
      resetOk = navigateReset(project, bin, home, homeIsTab);
    }
    if (!resetOk) {
      stats.resetFailed = true;
      log('  ! 复位到首页失败（连续两次无响应），本模块这次给不出结论');
      break;
    }
    sleep(settle);

    let cur = currentPage(project, bin);
    log('    复位后当前页: ' + (cur || '读不到'));
    if (cur === null) {
      stats.resetFailed = true;
      log('  ! 读不到当前页（模拟器无响应），已中止');
      break;
    }
    if (cur !== home) {
      stats.skipped++;
      hops.push({ to: t, skipped: '复位后当前页是 ' + cur + '，不是首页，本次跳过' });
      continue;
    }

    let clicked = 0;
    let brokeAt = null;
    let skipped = null;
    for (const e of path) {
      if (cur !== e.from) {
        brokeAt = '当前在 ' + cur + '，但这一步的入口在 ' + e.from;
        break;
      }
      log('    点击「' + (e.text || e.handler) + '」' + e.selector + ' …');
      const tapped = tapElement(project, bin, e.selector);
      if (tapped.skipped) { skipped = tapped.skipped; break; }
      if (!tapped.ok) {
        brokeAt = '点击调用本身失败（' + e.selector + '）';
        break;
      }
      clicked++;
      sleep(settle);
      const now = currentPage(project, bin);
      log('      点击后当前页: ' + (now || '读不到'));
      if (now === null) {
        skipped = '点击后读不到当前页，无法判断按钮结果';
        break;
      }
      cur = now;
      if (now !== e.to) {
        brokeAt = '点了「' + (e.text || e.handler) + '」后停在 ' + now + '，没进入 ' + e.to;
        break;
      }
    }

    if (skipped) { stats.skipped++; hops.push({ to:t, skipped, actualTaps:clicked, landedOn:cur }); continue; }
    const stack = pageStack(project, bin);
    const ok = cur === t;
    if (ok) stats.verified++;
    else stats.failed++;

    hops.push({
      from: path[0].from,
      to: t,
      text: path[0].text,
      selector: path[0].selector,
      ok,
      staticTaps: path.length,
      actualTaps: clicked,
      landedOn: cur,
      stackDepth: stack.length,
      brokeAt,
    });

    if (!ok) {
      issues.push({
        level: 'P1',
        rule: '入口点了进不去',
        where: path[0].from + ' 的「' + (path[0].text || '?') + '」',
        msg: (brokeAt || '点了 ' + clicked + ' 下没到达 ' + t) + '（静态分析认为这个入口能进入 ' + t + '）',
        fix: '确认这个入口是否失效。若它本来就需要登录/权限等前置条件，属正常，可忽略本条',
      });
    }
  }

  // 点击走完，把小程序复位回首页，别把用户留在某个二级页
  if (!stats.resetFailed && home) {
    navigateReset(project, bin, home, homeIsTab);
    sleep(0.6);
  }

  return { ran: true, home, hops, issues, stats, incomplete: stats.resetFailed || stats.skipped > 0 || targets.length < [...new Set(edges.map(e => e.to))].filter(t => t !== home).length };
}
