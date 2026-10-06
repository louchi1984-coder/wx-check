/**
 * 模块 E · 读内容（需要开发者工具已打开项目且已登录）
 *
 * 模块 B 只会量尺寸，本模块让工具「认字」，解决三件 B 做不到的事：
 *
 *  1. 文字被截断：把带 text-overflow: ellipsis 的元素找出来，
 *     读它的文字，用离屏画布量出文字实际宽度，跟元素宽度比 —— 装不下的就是被省略号吃掉的。
 *     （注意：automation_element_action 的 scrollWidth 动作只支持 scroll-view 组件，
 *      对普通 view 会报 `Cannot manipulate component scroll-view, got view`，所以走量文字这条路。）
 *  2. 分清「空数据」与「没渲染完」：读页面 data。列表字段非空却没采集到元素，才是真的没渲染完；
 *     列表本来就是空的，那些空 class 完全合法 —— 结果交给模块 B 决定要不要重采。
 *  3. WXML 引用了 data 里不存在的字段：字面上的绑定错误（拼写错、忘了初始化），
 *     界面上的表现就是那片区域永远空白。
 *
 * 实测（v0.3.11）：
 *   automation_page_action  getData                  → result.data 是页面 data 对象
 *   automation_element_action --action text          → result 直接是字符串
 *   automation_element_action --action size          → result.{width,height}
 *   automation_element_action --action style --name font-size → result 是 '15px'（必须用 CSS 连字符写法）
 *   automation_evaluate 里 wx.createOffscreenCanvas + measureText 可用 → 能真量出文字宽度
 */
import fs from 'fs';
import path from 'path';
import { wechatide, sleep, ensureReady } from './wechatide.mjs';

/** 量文字宽度时的容差：字体回退会让量出来偏窄，宁可漏报也不误报 */
const TOL_ABS = 4;
const TOL_REL = 0.08;

/**
 * 纯函数：量出来的文字宽度装不装得进这个盒子。
 * 留容差是因为离屏画布用的字体可能与真实渲染字体不同（偏窄），差一点点不算截断。
 */
export function judgeTruncation(textWidth, boxWidth) {
  const tol = Math.max(TOL_ABS, boxWidth * TOL_REL);
  return textWidth > boxWidth + tol;
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function readAppJson(project) {
  return JSON.parse(readText(path.join(project, 'app.json')));
}

function listPages(app) {
  const pages = [...(app.pages || [])];
  for (const sp of app.subPackages || app.subpackages || []) {
    const root = String(sp.root || '').replace(/\/$/, '');
    for (const p of sp.pages || []) pages.push(root + '/' + String(p).replace(/^\//, ''));
  }
  return pages.map((p) => p.replace(/^\//, '')).filter(Boolean);
}

/**
 * 静态：找出所有「具备截断条件」的 class —— 声明块里写了 text-overflow: ellipsis 的规则。
 * 只有这些类的元素才值得去量文字，所以整体调用量很小。
 */
export function ellipsisClasses(project) {
  const out = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'miniprogram_npm', '.mp-autocheck'].includes(e.name)) walk(full);
        continue;
      }
      if (!/\.wxss$/.test(e.name)) continue;
      const css = readText(full);
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/text-overflow\s*:\s*ellipsis/.test(m[2])) continue;
        for (const c of m[1].matchAll(/\.([A-Za-z0-9_-]+)/g)) out.add(c[1]);
      }
    }
  };
  walk(project);
  return [...out];
}

/** 静态：wxml 里所有插值表达式引用到的根标识符，以及 wx:for 声明的别名 */
export function bindingRefs(wxml) {
  const s = String(wxml);
  const loops = new Set(['item', 'index']);
  for (const m of s.matchAll(/wx:for-(?:item|index)\s*=\s*"([^"]+)"/g)) loops.add(m[1].trim());
  const roots = new Set();
  for (const m of s.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    // 先抹掉字符串字面量，免得把里面的词当成变量名
    const expr = m[1].replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``');
    for (const id of expr.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const name = id[0];
      const before = expr.slice(0, id.index).replace(/\s+$/, '');
      if (before.endsWith('.')) continue; // a.b 只关心根 a
      const after = expr.slice(id.index + name.length).replace(/^\s+/, '');
      if (after.startsWith('(')) continue; // 函数调用
      roots.add(name);
    }
  }
  return { roots: [...roots], loops: [...loops] };
}

/** 静态：从页面 js 的 data:{...} 抠出字段名（多抠几个无妨，方向是宁可不报） */
export function staticDataKeys(js) {
  const s = String(js);
  const m = /\bdata\s*:\s*\{/.exec(s);
  if (!m) return [];
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let inStr = null;
  let esc = false;
  let end = s.length;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (!depth) {
        end = i + 1;
        break;
      }
    }
  }
  const body = s.slice(start, end);
  const keys = [];
  for (const k of body.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) keys.push(k[1]);
  return [...new Set(keys)];
}

/** 运行时：把页面 data 归纳成「有没有列表内容」 */
export function dataSummary(data) {
  const keys = Object.keys(data || {}).filter((k) => !k.startsWith('__'));
  const arrays = {};
  const objects = {};
  for (const k of keys) {
    const v = data[k];
    if (Array.isArray(v)) arrays[k] = v.length;
    else if (v && typeof v === 'object') objects[k] = Object.keys(v).length;
  }
  const arrKeys = Object.keys(arrays);
  const hasList = arrKeys.some((k) => arrays[k] > 0);
  const hasObj = Object.keys(objects).some((k) => objects[k] > 0);
  let state = 'noList';
  if (hasList || hasObj) state = 'hasList';
  else if (arrKeys.length) state = 'emptyList';
  return { keys: keys.length, arrays, objects, state };
}

const BUILTIN = new Set([
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'Math', 'Date', 'JSON', 'String', 'Number', 'Boolean', 'Array', 'Object',
  'parseInt', 'parseFloat', 'isNaN', 'typeof', 'new', 'this',
]);

function elementCall(project, cls, action, extra, bin) {
  try {
    const r = wechatide(
      'automation_element_action',
      ['--project', project, '--selector', '.' + cls, '--action', action, ...(extra || [])],
      { bin, timeout: 45000 }
    );
    if (!r || r.ok === false) return null;
    return r.result;
  } catch {
    return null;
  }
}

/** 一次调用量出多条文字的实际宽度（离屏画布） */
function measureWidths(project, items, bin) {
  if (!items.length) return null;
  const fn =
    'function(){try{var IT=' + JSON.stringify(items) + ';' +
    'var c=wx.createOffscreenCanvas({type:"2d",width:10,height:10});' +
    'var ctx=c.getContext("2d");var out=[];' +
    'for(var i=0;i<IT.length;i++){ctx.font=IT[i].size+"px sans-serif";' +
    'out.push(Math.round(ctx.measureText(IT[i].text).width*10)/10);}' +
    'return out;}catch(e){return {err:String(e)};}}';
  try {
    const r = wechatide('automation_evaluate', ['--project', project, '--fn-source', fn], { bin, timeout: 60000 });
    if (!r || r.ok === false) return null;
    const v = r.result && r.result.result && r.result.result.result;
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} project
 * @param {string|null} bin
 * @param {Function} log
 * @param {{pages?:string[], ready?:boolean}} opts 覆盖页面列表（模块 B 已跑时复用同一份，避免结果不一致）
 */
export function auditContent(project, bin, log = () => {}, opts = {}) {
  const { ready = false } = opts;
  const app = readAppJson(project);
  const tabs = ((app.tabBar && app.tabBar.list) || []).map((i) => String(i.pagePath || '').replace(/^\//, ''));
  const pages = opts.pages || listPages(app);
  if (!pages.length) throw new Error('app.json 里没有页面');

  if (!ready) ensureReady(project, bin, { log });

  const ellipsis = new Set(ellipsisClasses(project));
  const issues = [];
  const pageData = {};
  const stats = {
    pages: 0,
    dataRead: 0,
    bindingChecked: 0,
    missingRefs: 0,
    ellipsisCandidates: 0,
    ellipsisChecked: 0,
    truncated: 0,
    measureFailed: 0,
  };

  for (const page of pages) {
    const wxml = readText(path.join(project, page + '.wxml'));
    let nav = { ok: true };
    try {
      nav = wechatide(
        'automation_navigate',
        ['--project', project, '--action', tabs.includes(page) ? 'switchTab' : 'reLaunch', '--url', '/' + page, '--wait', '1.5'],
        { bin }
      );
    } catch (e) {
      nav = { ok: false, message: e.message };
    }
    if (nav.ok === false) {
      log('  ! ' + page + ' 导航失败，本页内容检查跳过');
      continue;
    }
    sleep(1.2);
    stats.pages++;

    // ── 读页面 data ────────────────────────────────────────────
    let data = null;
    try {
      const r = wechatide('automation_page_action', ['--project', project, '--action', 'getData'], { bin, timeout: 45000 });
      if (r && r.ok !== false && r.result && r.result.success !== false) data = r.result.data;
    } catch {
      data = null;
    }
    if (data) {
      stats.dataRead++;
      pageData[page] = dataSummary(data);
    }

    // ── 绑定检查：WXML 引用的字段在不在 ───────────────────────
    if (data) {
      const { roots, loops } = bindingRefs(wxml);
      const allowed = new Set([
        ...loops,
        ...Object.keys(data),
        ...staticDataKeys(readText(path.join(project, page + '.js'))),
      ]);
      const missing = roots.filter((r) => !allowed.has(r) && !BUILTIN.has(r));
      stats.bindingChecked++;
      if (missing.length) {
        stats.missingRefs += missing.length;
        issues.push({
          level: 'P1',
          rule: 'WXML 引用了页面没有的字段',
          where: page + '.wxml',
          msg: '{{ ' + missing.join(' }}、{{ ') + ' }} 在页面 data 与 js 的 data 初值里都找不到。界面上表现为这块永远空白（也可能是交互后才赋的值，需人工确认）',
          fix: '核对字段拼写，或在 data 初值里补上默认值',
        });
      }
    }

    // ── 文字截断 ──────────────────────────────────────────────
    const onPage = [...ellipsis].filter((c) => new RegExp('class="[^"]*\\b' + c + '\\b').test(wxml));
    stats.ellipsisCandidates += onPage.length;
    const measureList = [];
    const meta = [];
    for (const cls of onPage) {
      const text = elementCall(project, cls, 'text', null, bin);
      if (typeof text !== 'string' || !text.trim()) continue;
      const size = elementCall(project, cls, 'size', null, bin);
      if (!size || !size.width) continue;
      const te = elementCall(project, cls, 'style', ['--name', 'text-overflow'], bin);
      if (String(te || '') !== 'ellipsis') continue;
      const fsz = elementCall(project, cls, 'style', ['--name', 'font-size'], bin);
      const px = parseFloat(String(fsz || '')) || 14;
      measureList.push({ text, size: px });
      meta.push({ cls, text, boxWidth: size.width, fontSize: px });
    }

    if (measureList.length) {
      const widths = measureWidths(project, measureList, bin);
      if (!widths) {
        stats.measureFailed += measureList.length;
        log('  ! ' + page + ' 文字宽度测量失败，截断检查已跳过（结论不完整）');
      } else {
        meta.forEach((m, i) => {
          const tw = Number(widths[i]);
          if (!isFinite(tw)) return;
          stats.ellipsisChecked++;
          if (judgeTruncation(tw, m.boxWidth)) {
            stats.truncated++;
            issues.push({
              level: 'P1',
              rule: '文字被截断',
              where: page + ' .' + m.cls,
              msg: '「' + m.text.slice(0, 30) + '」按 ' + m.fontSize + 'px 量出宽 ' + Math.round(tw) +
                'px，但元素只有 ' + Math.round(m.boxWidth) + 'px，放不下会被省略号吃掉',
              fix: '放宽元素宽度、缩小字号，或把内容改成换行显示（去掉 white-space: nowrap）',
            });
          }
        });
      }
    }
    log('  ' + page.padEnd(28) + (pageData[page] ? 'data ' + pageData[page].keys + ' 个字段/' + pageData[page].state : 'data 读取失败') +
      (onPage.length ? '，截断候选 ' + onPage.length : ''));
  }

  return { issues, stats, pageData };
}
