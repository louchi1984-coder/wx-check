/**
 * 模块 · 流程测试（ux-audit）
 *
 * 跟其它模块的区别：
 *   - nav-cost 的入口识别：只读代码，推算「应该点几下」（静态）
 *   - 模块 G 真点击：只验证「入口点得进去吗」（一次点击 + 看当前页）
 *   - 本模块 H：**以体验者身份把一件事做完**。进页面 → 填表 → 提交 → 看结果，
 *     并且回答体验层面的问题：要几步、空着提交会不会被拦、被拦了有没有提示、
 *     提交完有没有反馈、危险操作有没有后路。
 *
 * ★ 能力边界（必须如实写进报告，不许假装能做到）★
 *   微信的 toast / showModal 是**原生层**渲染，页面 DOM 里查不到（实测 .wx-toast / .weui-toast
 *   等选择器全部命中不到）。所以「有没有弹提示」不能直接观察，只能**交叉判定**：
 *     静态：提交方法体里到底有没有 showToast/showModal 这样的提示代码
 *     运行时：点击后当前页变了吗、页面 data 变了吗
 *   两者合并才知道是「被拦下且有提示」还是「点了彻底没反应」。
 *   另一类机器判不了的：配色、字号、间距、文案是否通顺、图标是否易懂 —— 这些只能人看。
 *
 * ★ 安全约束 ★
 *   ① 测试会真写数据（不真用一遍就还是「看按钮能不能点」）。因此**开始前备份 storage、
 *      结束后在finally中恢复并逐项核验**；失败保留工程外备份并停止后续写入。
 *   ② 任何点击/输入前先用 querySelectorAll 数元素，**只有恰好命中 1 个**才操作；
 *      命中多个一律不动（这正是之前「点错元素、还改写了数据」的根因）。
 *   ③ 危险操作（删除/清空/重置一类）**只做静态判定，永不点击**。
 */
import { tapTargets, classTokens } from './nav-cost.mjs';
import { wechatide, sleep } from './wechatide.mjs';
import { createStorageGuard } from './storage-guard.mjs';
import { assertAutomationPage } from './page-context.mjs';

/** 取 <tag ...> 开标签的属性串 */
function attr(attrs, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(attrs);
  return m ? m[1] : '';
}

/** 提交类按钮的文案特征 */
const SUBMIT_WORDS = /保存|提交|确定|完成|添加|创建|发布|发送|登录|记一笔|开始|立即/;
/** 危险操作文案特征 */
const DANGER_WORDS = /删除|清空|重置|退出|注销|解绑|移除|恢复默认|全部清除/;
/** 有用户可见反馈的调用 */
const FEEDBACK_APIS = /wx\.(showToast|showModal|showLoading|showActionSheet)\s*\(/;

/** 抽出一页里的输入控件（input / textarea / picker） */
export function formInputs(wxml) {
  const out = [];
  const re = /<(input|textarea|picker)\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(wxml))) {
    const attrs = m[2];
    const tag = m[1];
    const cls = attr(attrs, 'class');
    out.push({
      tag,
      classes: classTokens(cls).classes,
      dynamicClass: classTokens(cls).dynamic,
      type: attr(attrs, 'type') || (tag === 'picker' ? 'picker' : 'text'),
      placeholder: attr(attrs, 'placeholder'),
      handler: attr(attrs, 'bindinput') || attr(attrs, 'bindchange') || '',
      required: !!attr(attrs, 'required') || false,
    });
  }
  return out;
}

/** 从 js 源码里取某个方法的函数体（括号配平；找不到返回 ''） */
export function methodBodyOrNull(js, name) {
  if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  const re = new RegExp('(?:^|[^\\w$.])' + name + '\\s*(?::\\s*(?:async\\s+)?function\\s*)?\\([^)]*\\)\\s*\\{', 'g');
  let m;
  while ((m = re.exec(js))) {
    const start = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = start; i < js.length; i++) {
      const ch = js[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (!depth) return js.slice(start + 1, i);
      }
    }
  }
  return null;
}

/** 取方法体；找不到或为空都返回 ''。要区分“找不到”和“空函数体”（如 noop: function () {}）用 methodBodyOrNull。 */
export function methodBody(js, name) {
  return methodBodyOrNull(js, name) ?? '';
}

/**
 * 纯函数：静态解析一页的「可完成任务」。
 *
 * 一个任务 = 一个提交按钮 + 该页的输入控件。
 * 只认文案明确的提交按钮（保存/提交/确定…），不认识就返回空——
 * 宁可漏报也不乱点，避免误触「清空全部数据」这类按钮。
 *
 * ★ 硬前提：这一页必须真的有输入框，才认为按钮是「提交」。
 *   否则「记一笔支出」这种纯导航按钮会被误判成提交，进而误报「空提交也能过」。
 */
export function findForms(wxml, js) {
  const taps = tapTargets(wxml);
  const inputs = formInputs(wxml).filter((i) => i.classes.length);

  // 没有输入控件 = 不是表单页，整页不产生提交任务
  if (!inputs.length) return { tasks: [], inputs: [] };

  const tasks = [];
  for (const t of taps) {
    if (!SUBMIT_WORDS.test(t.text)) continue;
    const body = methodBody(js, t.handler);
    tasks.push({
      handler: t.handler,
      text: t.text,
      classes: t.classes,
      selector: t.classes.length ? '.' + t.classes.join('.') : '',
      // 静态看到的反馈能力
      feedbackApi: (FEEDBACK_APIS.exec(body) || [])[1] || null,
      hasReturn: /\breturn\b/.test(body),
      // 方法体里出现了「没填/请输入/不能为空」这类字眼的校验
      guardHint: /请输入|不能为空|请填|请选择|必填|无效|不合法/.test(body),
      navApi: (/(wx\.(navigateTo|redirectTo|reLaunch|switchTab|navigateBack))/.exec(body) || [])[1] || null,
      inputs,
    });
  }
  return { tasks, inputs };
}

/**
 * 纯函数：静态识别危险操作，以及它有没有二次确认。
 * @param {string} wxml
 * @param {string} js
 */
export function findDangerOps(wxml, js) {
  const taps = tapTargets(wxml);
  const out = [];
  for (const t of taps) {
    if (!DANGER_WORDS.test(t.text)) continue;
    const body = methodBody(js, t.handler);
    out.push({
      text: t.text,
      handler: t.handler,
      selector: t.classes.length ? '.' + t.classes.join('.') : '',
      confirm: /wx\.showModal\s*\(/.test(body),
      undo: /恢复|撤销|undo/i.test(body) || /wx\.showModal\s*\(/.test(body),
    });
  }
  return out;
}

/**
 * 纯函数：判断一次「空提交」的结果属于哪种情况。
 *
 * @param {{pageChanged:boolean, dataChanged:boolean, feedbackApi:string|null, guardHint:boolean}} o
 * @returns {{level:'ok'|'P1'|'P2', kind:string, msg:string}}
 */
export function judgeEmptySubmit(o) {
  // 空着提交居然跳走了 —— 没有任何必填校验，脏数据直接进库
  if (o.pageChanged) {
    return {
      level: 'P1',
      kind: '空提交也能过',
      msg: '什么都没填就直接提交，居然跳到了下一页——没有任何必填校验，脏数据会进库。',
    };
  }
  // 没跳转但改了数据：可能是「清空/重置」这类合法行为，也可能是写进了空记录，需要人看一眼
  if (o.dataChanged) {
    return {
      level: 'P2',
      kind: '空提交改动了数据',
      msg:
        '什么都没填就提交，页面没跳但数据被改了。如果这个按钮本来就是「清空/重置」语义属正常，' +
        '否则说明空值被当成有效输入写进去了，建议人工确认。',
    };
  }
  if (o.feedbackApi || o.guardHint) {
    return {
      level: 'ok',
      kind: '被拦住了且有提示',
      msg:
        '空提交被挡下' +
        (o.guardHint ? '，代码里有必填/格式校验并给出提示文字' : '') +
        (o.feedbackApi ? '（用了 ' + o.feedbackApi + '）' : '') +
        '。',
    };
  }
  return {
    level: 'P1',
    kind: '点了没反应',
    msg:
      '空提交后页面没跳、数据没变，而且代码里**看不到任何提示**——用户会以为按钮坏了。' +
      '（说明：toast 属原生层，本工具看不到，此结论来自「无提示代码 + 无任何变化」的交叉判定）',
  };
}

/**
 * 纯函数：判断一次「正常提交」的结果。
 */
export function judgeSubmit(o) {
  if (o.pageChanged) return { level: 'ok', kind: '提交后发生跳转', msg: '提交后跳转到 ' + o.landedOn + '。' };
  if (o.dataChanged) return { level: 'ok', kind: '提交后页面数据变化', msg: '提交后留在本页，但数据已变化。' };
  return {
    level: 'P2',
    kind: '提交后没有变化',
    msg: '填了合法值提交，页面没跳转、数据也没变，用户不知道到底成没成功。',
  };
}

/* ═══════════════  以下为真跑部分（会操作模拟器）  ═══════════════ */

function CALL(project, bin, tool, args, timeout = 90000, call = wechatide) {
  if (tool === 'automation_element_action' || (tool === 'automation_page_action' && args.includes('getData'))) {
    assertAutomationPage(project, bin, call);
  }
  try {
    return call(tool, ['--project', project, ...args], { bin, timeout });
  } catch (e) {
    return { __err: String(e.message).slice(0, 200) };
  }
}

export function currentPage(project, bin) {
  const r = CALL(project, bin, 'automation_runtime_info', ['--action', 'currentPage']);
  const cp = r && r.result && r.result.currentPage;
  return (cp && cp.path) || null;
}

export function pageData(project, bin) {
  const r = CALL(project, bin, 'automation_page_action', ['--action', 'getData']);
  const d = r && r.result && r.result.data;
  return d ? d.data || d : null;
}

/** 一个选择器当前命中几个元素。返回 -1 表示读不到（模拟器无响应）。 */
export function hitCount(project, bin, selector, call = wechatide) {
  const r = CALL(project, bin, 'automation_page_action', ['--action', 'querySelectorAll', '--selector', selector], 20000, call);
  if (!r || r.__err) return -1;
  const els = r && r.result && r.result.elements;
  return Array.isArray(els) ? els.length : -1;
}

/** 只有恰好命中 1 个元素时才点击 —— 这是「不点错元素」的唯一保证 */
export function tapUnique(project, bin, selector, call = wechatide) {
  const n = hitCount(project, bin, selector, call);
  if (n < 0) return { ok: false, why: '读不到元素（模拟器无响应）' };
  if (n === 0) return { ok: false, why: '元素不存在（可能没渲染）' };
  if (n > 1) return { ok: false, why: '命中 ' + n + ' 个元素，不唯一' };
  const r = CALL(project, bin, 'automation_element_action', ['--action', 'tap', '--selector', selector], 20000, call);
  if (!r || r.__err) return { ok: false, why: r && r.__err };
  if (r.ok === false) return { ok: false, why: r.message || '调用失败' };
  return { ok: r.result ? r.result.success !== false : true, why: '' };
}

/** 只有恰好命中 1 个元素时才输入 */
export function fillUnique(project, bin, selector, value, call = wechatide) {
  const n = hitCount(project, bin, selector, call);
  if (n < 0) return { ok: false, why: '读不到元素' };
  if (n === 0) return { ok: false, why: '元素不存在' };
  if (n > 1) return { ok: false, why: '命中 ' + n + ' 个元素，不唯一' };
  const r = CALL(project, bin, 'automation_element_action', ['--action', 'input', '--selector', selector, '--value', value], 20000, call);
  if (!r || r.__err) return { ok: false, why: r && r.__err };
  if (r.ok === false) return { ok: false, why: r.message || '调用失败' };
  return { ok: true, why: '' };
}

/** 页面快照：当前页 + data 指纹 */
function snap(project, bin) {
  const page = currentPage(project, bin);
  const data = pageData(project, bin);
  return { page, sig: data ? JSON.stringify(data) : '' };
}

/** mode: 'tab'（底部 tab）| 'navigate'（压栈进入）| 'relaunch'（清栈重开） */
function goNav(project, bin, page, mode) {
  const action = mode === 'tab' ? 'switchTab' : mode === 'navigate' ? 'navigateTo' : 'reLaunch';
  const r = CALL(project, bin, 'automation_navigate', ['--action', action, '--url', '/' + page, '--wait', '1.5']);
  return !!(r && !r.__err && r.result && r.result.success !== false);
}

/**
 * 用「真实用户的进入方式」到达某页。
 *
 * ★ 为什么非 tab 页必须 navigateTo、不能 reLaunch（踩过，别改回去）：
 *   实测用 reLaunch 直接进录入页 → 页面栈只剩 1 层 → 页面里提交后的 wx.navigateBack()
 *   无处可退、静默失败 → 被误判成「提交成功但没有变化」。
 *   真实用户是从首页点进去的（栈 2 层），所以非 tab 页统一「先回首页 → 再 navigateTo」。
 */
function enterPage(project, bin, page, isTab, home, homeIsTab) {
  if (!home || page === home) return goNav(project, bin, page, isTab ? 'tab' : 'relaunch');
  if (isTab) return goNav(project, bin, page, 'tab');
  goNav(project, bin, home, homeIsTab ? 'tab' : 'relaunch');
  sleep(0.9);
  if (goNav(project, bin, page, 'navigate')) return true;
  return false; // 不清栈冒充真实进入方式
}

/** 给「填合法值」挑一个输入框：优先数字类，其次第一个 */
export function pickFillInput(inputs = []) {
  const cands = inputs.filter((i) => i.classes && i.classes.length);
  const num = cands.find((i) => i.type === 'digit' || i.type === 'number');
  const one = num || cands[0];
  return one ? { selector: '.' + one.classes.join('.'), type: one.type, placeholder: one.placeholder } : null;
}

/**
 * 以体验者身份把每个页面上的任务做一遍。
 *
 * @param {string} project
 * @param {Array<{page:string,isTab:boolean,tasks:Array,inputs:Array}>} plan 静态解析结果
 * @param {string|null} bin
 * @param {Function} log
 * @param {{settle?:number, home?:string, homeIsTab?:boolean, fillValue?:string}} opts
 */
export function formFillPlan(inputs = [], values = {}, fallback = '1') {
  if (!inputs.length) return { error: '没有输入控件' };
  const fields = [];
  for (const input of inputs) {
    if (!input.classes?.length || input.classes.some(c => !/^[A-Za-z0-9_-]+$/.test(c))) return { error: '输入控件无法唯一定位，需场景补测' };
    if (!['input', 'textarea'].includes(input.tag)) return { error: '选择器等控件需按业务场景操作，不能用input冒充' };
    const selector = '.' + input.classes.join('.');
    const value = Object.prototype.hasOwnProperty.call(values, selector) ? values[selector] : inputs.length === 1 ? fallback : undefined;
    if (typeof value !== 'string' || !value.length) return { error: '缺少已确认的合法字段值：' + selector };
    fields.push({ selector, value });
  }
  return { fields };
}

export function auditUx(project, plan, bin, log = () => {}, opts = {}) {
  const { settle = 1.6, home = '', homeIsTab = false, fillValue = '1', values = {} } = opts;
  const driver = opts.driver || {
    enter: p => enterPage(project, bin, p.page, p.isTab, home, homeIsTab),
    count: selector => hitCount(project, bin, selector),
    fill: (selector, value) => fillUnique(project, bin, selector, value),
    value: selector => {
      const r = CALL(project, bin, 'automation_element_action', ['--action', 'value', '--selector', selector]);
      if (!r || r.__err || r.ok === false) throw Error('无法核对输入控件值');
      const value = r.result;
      if (typeof value !== 'string' && typeof value !== 'number') throw Error('输入值返回格式异常');
      return String(value);
    },
    tap: selector => tapUnique(project, bin, selector),
    snap: () => snap(project, bin),
    sleep,
    finish: () => { if (home && !goNav(project, bin, home, homeIsTab ? 'tab' : 'relaunch')) throw Error('未能恢复首页'); },
  };
  const hops = [], issues = [];
  const stats = { pages: 0, tasks: 0, blocked: 0, leaked: 0, silent: 0, ok: 0, notUnique: 0, restored: false };
  // 可靠备份及落盘成功后才允许进入页面、点击、输入。
  let guard;
  try { guard = opts.guardFactory ? opts.guardFactory() : createStorageGuard(project, bin, { backupDir: opts.backupDir, call: opts.call }); }
  catch (e) { return {ran:false,hops,issues,stats,backedUp:false,backupFile:null,executionError:'备份失败，未执行业务操作：'+e.message,restoreError:null,incomplete:true}; }
  let executionError = null, restoreError = null;
  const snapshot = () => {
    const s = driver.snap();
    if (!s?.page || !s.sig) throw Error('页面状态读取失败，停止提交');
    return s;
  };
  const fillAll = fields => {
    for (const f of fields) {
      if (driver.count(f.selector) !== 1) return { ok:false, why:'输入控件不存在或不唯一：'+f.selector };
      const r = driver.fill(f.selector, f.value);
      if (!r.ok || driver.value(f.selector) !== f.value) return { ok:false, why:'输入未核实：'+f.selector };
    }
    return { ok:true };
  };
  try {
    for (const p of plan) {
      stats.pages++;
      for (const t of p.tasks) {
        stats.tasks++;
        const filledPlan = formFillPlan(t.inputs, values[p.page] || {}, fillValue);
        if (filledPlan.error) { hops.push({page:p.page,text:t.text,skipped:filledPlan.error}); continue; }
        if (!driver.enter(p)) { hops.push({page:p.page,text:t.text,skipped:'未能通过真实返回栈进入页面'}); continue; }
        driver.sleep(settle);
        if (driver.count(t.selector) !== 1) { stats.notUnique++; hops.push({page:p.page,text:t.text,skipped:'提交按钮尚未出现或不唯一，需补充前置操作'}); continue; }
        const cleared = fillAll(filledPlan.fields.map(f => ({...f,value:''})));
        if (!cleared.ok) { hops.push({page:p.page,text:t.text,skipped:'空提交准备失败：'+cleared.why}); continue; }
        const b1 = snapshot(), r1 = driver.tap(t.selector);
        driver.sleep(settle);
        const a1 = snapshot();
        const empty = r1.ok ? judgeEmptySubmit({pageChanged:b1.page!==a1.page,dataChanged:b1.sig!==a1.sig,feedbackApi:t.feedbackApi,guardHint:t.guardHint}) : {level:'skip',kind:'未测成',msg:r1.why};
        if (empty.level === 'ok') stats.blocked++;
        else if (empty.level !== 'skip') { if(empty.kind==='空提交也能过') stats.leaked++; else stats.silent++; issues.push({level:empty.level,rule:empty.kind,where:p.page+' 的「'+t.text+'」',msg:empty.msg}); }
        if (!driver.enter(p)) { hops.push({page:p.page,text:t.text,empty,skipped:'正常提交前无法重新进入'}); continue; }
        driver.sleep(settle);
        const filled = fillAll(filledPlan.fields);
        let sub = {level:'skip',kind:'未测成',msg:filled.why || '提交按钮不存在或不唯一'};
        let r2 = {ok:false};
        if (filled.ok && driver.count(t.selector) === 1) {
          const b2 = snapshot(); r2 = driver.tap(t.selector); driver.sleep(settle*1.5); const a2 = snapshot();
          // 这里只提供响应线索，最终保存等业务结果必须另行核验。
          sub = r2.ok ? judgeSubmit({pageChanged:b2.page!==a2.page,dataChanged:b2.sig!==a2.sig,landedOn:a2.page}) : {level:'skip',kind:'未测成',msg:r2.why};
          if (sub.level === 'ok') stats.ok++;
          else if(sub.level==='P2') issues.push({level:'P2',rule:sub.kind,where:p.page+' 的「'+t.text+'」',msg:sub.msg});
        }
        hops.push({page:p.page,text:t.text,selector:t.selector,empty,submit:sub,businessResult:'未由表单辅助核验',tapsInPage:filledPlan.fields.length+(r2.ok?1:0),filledWith:filledPlan.fields.map(f=>f.selector+' ← '+f.value).join('；')});
      }
    }
  } catch (e) { executionError = e.message; }
  finally {
    try { stats.restored = guard.restore(); if(!stats.restored) restoreError='存储恢复未通过核验'; } catch(e) { restoreError=e.message; }
    try { driver.finish(); } catch(e) { executionError=executionError || e.message; }
  }
  log('  · 存储恢复：'+(stats.restored?'所有键和值核验一致':'失败；备份保留于 '+guard.backupFile));
  return { ran:true,hops,issues,stats,backedUp:true,backupFile:guard.backupFile,executionError,restoreError,
    incomplete:!!executionError || !stats.restored || hops.some(h=>h.skipped || h.empty?.level==='skip' || h.submit?.level==='skip') };
}
