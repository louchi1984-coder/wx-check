/**
 * 模块 · 体验走查（ux-audit）
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
 *   ① 走查会真写数据（不真用一遍就还是「看按钮能不能点」）。因此**开始前备份 storage、
 *      结束后原样还原**，不给用户留垃圾数据。
 *   ② 任何点击/输入前先用 querySelectorAll 数元素，**只有恰好命中 1 个**才操作；
 *      命中多个一律不动（这正是之前「点错元素、还改写了数据」的根因）。
 *   ③ 危险操作（删除/清空/重置一类）**只做静态判定，永不点击**。
 */
import { tapTargets } from './nav-cost.mjs';
import { wechatide, sleep } from './wechatide.mjs';

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
      classes: cls.split(/\s+/).filter(Boolean),
      type: attr(attrs, 'type') || (tag === 'picker' ? 'picker' : 'text'),
      placeholder: attr(attrs, 'placeholder'),
      handler: attr(attrs, 'bindinput') || attr(attrs, 'bindchange') || '',
      required: !!attr(attrs, 'required') || false,
    });
  }
  return out;
}

/** 从 js 源码里取某个方法的函数体（括号配平；找不到返回 ''） */
export function methodBody(js, name) {
  if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return '';
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
  return '';
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
  if (o.pageChanged) return { level: 'ok', kind: '提交成功并跳转', msg: '提交后跳转到 ' + o.landedOn + '。' };
  if (o.dataChanged) return { level: 'ok', kind: '提交成功（留在本页）', msg: '提交后留在本页，但数据已变化。' };
  return {
    level: 'P2',
    kind: '提交后没有变化',
    msg: '填了合法值提交，页面没跳转、数据也没变，用户不知道到底成没成功。',
  };
}

/* ═══════════════  以下为真跑部分（会操作模拟器）  ═══════════════ */

function CALL(project, bin, tool, args, timeout = 90000) {
  try {
    return wechatide(tool, ['--project', project, ...args], { bin, timeout });
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
export function hitCount(project, bin, selector) {
  const r = CALL(project, bin, 'automation_page_action', ['--action', 'querySelectorAll', '--selector', selector]);
  if (!r || r.__err) return -1;
  const els = r && r.result && r.result.elements;
  return Array.isArray(els) ? els.length : -1;
}

/** 只有恰好命中 1 个元素时才点击 —— 这是「不点错元素」的唯一保证 */
export function tapUnique(project, bin, selector) {
  const n = hitCount(project, bin, selector);
  if (n < 0) return { ok: false, why: '读不到元素（模拟器无响应）' };
  if (n === 0) return { ok: false, why: '元素不存在（可能没渲染）' };
  if (n > 1) return { ok: false, why: '命中 ' + n + ' 个元素，不唯一' };
  const r = CALL(project, bin, 'automation_element_action', ['--action', 'tap', '--selector', selector]);
  if (!r || r.__err) return { ok: false, why: r && r.__err };
  if (r.ok === false) return { ok: false, why: r.message || '调用失败' };
  return { ok: r.result ? r.result.success !== false : true, why: '' };
}

/** 只有恰好命中 1 个元素时才输入 */
export function fillUnique(project, bin, selector, value) {
  const n = hitCount(project, bin, selector);
  if (n < 0) return { ok: false, why: '读不到元素' };
  if (n === 0) return { ok: false, why: '元素不存在' };
  if (n > 1) return { ok: false, why: '命中 ' + n + ' 个元素，不唯一' };
  const r = CALL(project, bin, 'automation_element_action', ['--action', 'input', '--selector', selector, '--value', value]);
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
  return goNav(project, bin, page, 'relaunch'); // 兜底：navigateTo 进不去就清栈重开
}

/**
 * evaluate 的返回值嵌套层数比别的工具深：{result:{success,result:{result:<值>}}}。
 * 逐层剥掉 result，直到拿到真正的值（别写死层数，工具改版会变）。
 */
function unwrapEval(r) {
  let v = r;
  for (let i = 0; i < 6; i++) {
    if (!v || typeof v !== 'object') break;
    if (v.result === undefined) break;
    v = v.result;
  }
  return v;
}

/** 读整个本地存储（用于走查前的备份） */
function storageDump(project, bin) {
  const fn =
    "function(){try{var i=wx.getStorageInfoSync();var o={};i.keys.forEach(function(k){o[k]=wx.getStorageSync(k)});return JSON.stringify(o)}catch(e){return ''}}";
  const r = CALL(project, bin, 'automation_evaluate', ['--fn-source', fn], 60000);
  const v = unwrapEval(r);
  return typeof v === 'string' && v.trim() ? v : '{}';
}

/** 原样还原存储（走查不留垃圾数据） */
function storageRestore(project, bin, dumped) {
  // 入参必须是 JSON 字符串；拿不到就宁可不还原，也绝不「先清空再解析失败」
  if (typeof dumped !== 'string' || !dumped.trim()) return false;
  try { JSON.parse(dumped); } catch { return false; }
  const fn =
    'function(){try{var ks=wx.getStorageInfoSync().keys;ks.forEach(function(k){wx.removeStorageSync(k)});var d=JSON.parse(' +
    JSON.stringify(dumped) +
    ");Object.keys(d).forEach(function(k){wx.setStorageSync(k,d[k])});return 'ok'}catch(e){return 'e:'+e}}";
  const v = unwrapEval(CALL(project, bin, 'automation_evaluate', ['--fn-source', fn], 60000));
  return v === 'ok';
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
export function auditUx(project, plan, bin, log = () => {}, opts = {}) {
  const { settle = 1.6, home = '', homeIsTab = false, fillValue = '1' } = opts;
  const hops = [];
  const issues = [];
  const stats = { pages: 0, tasks: 0, blocked: 0, leaked: 0, silent: 0, ok: 0, notUnique: 0, restored: false };

  const backup = storageDump(project, bin);
  log('  · 已备份本地存储，走查结束后原样还原');

  for (const p of plan) {
    stats.pages++;
    log('  · 页面 ' + p.page + '（' + p.tasks.length + ' 个提交任务）');

    for (const t of p.tasks) {
      stats.tasks++;

      if (!enterPage(project, bin, p.page, p.isTab, home, homeIsTab)) {
        log('    ! 打不开 ' + p.page + '，跳过');
        hops.push({ page: p.page, text: t.text, skipped: '打不开这一页' });
        continue;
      }
      sleep(settle);

      const n = hitCount(project, bin, t.selector);
      if (n !== 1) {
        stats.notUnique++;
        log('    · 「' + t.text + '」' + t.selector + ' 命中 ' + n + ' 个，不唯一，跳过（不乱点）');
        hops.push({ page: p.page, text: t.text, selector: t.selector, skipped: '元素不唯一（命中 ' + n + ' 个）' });
        continue;
      }

      // —— ① 空提交：什么都不填直接点
      log('    · 空提交「' + t.text + '」…');
      const b1 = snap(project, bin);
      const r1 = tapUnique(project, bin, t.selector);
      sleep(settle);
      const a1 = snap(project, bin);
      const empty = r1.ok
        ? judgeEmptySubmit({
            pageChanged: b1.page !== a1.page,
            dataChanged: b1.sig !== a1.sig,
            feedbackApi: t.feedbackApi,
            guardHint: t.guardHint,
          })
        : { level: 'P2', kind: '点不动', msg: '这一步点击没成功：' + r1.why };
      if (empty.level === 'ok') stats.blocked++;
      else if (empty.kind === '空提交也能过') stats.leaked++;
      else stats.silent++;
      if (empty.level !== 'ok') {
        issues.push({ level: empty.level, rule: empty.kind, where: p.page + ' 的「' + t.text + '」', msg: empty.msg });
      }

      // —— ② 正常填值提交
      if (!enterPage(project, bin, p.page, p.isTab, home, homeIsTab)) continue;
      sleep(settle);
      const fill = pickFillInput(t.inputs);
      let filled = { ok: false, why: '这一页没有可填的输入框' };
      if (fill && hitCount(project, bin, fill.selector) === 1) {
        filled = fillUnique(project, bin, fill.selector, fillValue);
      }
      const b2 = snap(project, bin);
      const r2 = filled.ok ? tapUnique(project, bin, t.selector) : { ok: false, why: '没填成，跳过提交' };
      sleep(settle * 1.5);
      const a2 = snap(project, bin);
      const sub = r2.ok
        ? judgeSubmit({ pageChanged: b2.page !== a2.page, dataChanged: b2.sig !== a2.sig, landedOn: a2.page })
        : { level: 'skip', kind: '没走成', msg: '填值/提交没成功：' + r2.why };
      if (sub.level === 'ok') stats.ok++;
      else if (sub.level === 'P2') issues.push({ level: 'P2', rule: sub.kind, where: p.page + ' 的「' + t.text + '」', msg: sub.msg });

      hops.push({
        page: p.page,
        text: t.text,
        selector: t.selector,
        empty: { level: empty.level, kind: empty.kind, msg: empty.msg },
        submit: { level: sub.level, kind: sub.kind, msg: sub.msg },
        // 体验成本：进这一页 1 下 + 填值 1 下 + 提交 1 下
        tapsInPage: (filled.ok ? 1 : 0) + (r2.ok ? 1 : 0),
        filledWith: fill ? fill.selector + ' ← 「' + fillValue + '」' : null,
      });
      log('      空提交：' + empty.kind + ' ｜ 正常提交：' + sub.kind);
    }
  }

  // —— 收尾：还原存储 + 回到首页
  stats.restored = storageRestore(project, bin, backup);
  if (home) {
    goNav(project, bin, home, homeIsTab ? 'tab' : 'relaunch');
    sleep(0.8);
  }
  log('  · 已还原本地存储：' + (stats.restored ? '成功（未留测试数据）' : '失败，请手动检查'));

  return { ran: true, hops, issues, stats, backedUp: backup !== '{}' };
}

