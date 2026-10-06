/**
 * 模块 · 操作成本（静态）
 *
 * 回答三个问题：某个功能**进得去吗、要几下、回得来吗**。
 *
 * 全部靠静态解析（app.json + 各页 wxml/js），不碰模拟器、不改工程：
 *   - wxml 里带 bindtap/catchtap 的元素 → 可点目标（连同展示文字）
 *   - js 里 wx.navigateTo/redirectTo/reLaunch/switchTab 的字面量 url → 页面跳转边
 *   - js 里 wx.navigateBack → 返回能力
 *   - app.json tabBar.list → 底部直达页
 *
 * 动态拼接的 url（如 '/pages/a/a?id=' + id）无法静态解析，按 unknown 记，不猜。
 */
import fs from 'fs';
import path from 'path';

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function readJson(p) {
  try {
    return JSON.parse(readText(p));
  } catch {
    return null;
  }
}

/** 取 <tag ...> 开标签的属性串 */
function attr(attrs, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(attrs);
  return m ? m[1] : '';
}

/**
 * 抽出一页里所有可点元素：handler 名、class 列表、展示文字。
 * 文字取标签到下一个 '<' 之间的内容，插值表达式折成 '…'。
 */
export function tapTargets(wxml) {
  const out = [];
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(wxml))) {
    const attrs = m[2];
    const h = /\b(?:bind|catch)[:]?tap\s*=\s*"([^"]+)"/.exec(attrs);
    if (!h) continue;
    const rest = wxml.slice(re.lastIndex);
    const end = rest.indexOf('<');
    const inner = end < 0 ? rest : rest.slice(0, end);
    const text = inner
      .replace(/\{\{[\s\S]*?\}\}/g, '…')
      .replace(/\s+/g, ' ')
      .trim();
    out.push({
      tag: m[1],
      handler: h[1],
      classes: attr(attrs, 'class').split(/\s+/).filter(Boolean),
      text: text.length > 16 ? text.slice(0, 16) + '…' : text,
    });
  }
  return out;
}

/**
 * 抽出一页 js 里的跳转调用。
 *
 * url 的处理分三种，判错会让「真点击」去点错地方，所以要分清：
 *   ① 纯字面量           '/pages/add/add'            → 安全
 *   ② 字面量 + query 拼接 '/pages/add/add?type=' + t  → 安全，取 '?' 前的部分
 *   ③ 路径本身被拼接      '/pages/d/' + id             → **不安全**，记 unknown（'pages/d/' 不是真页面）
 */
export function navCalls(js) {
  const out = [];
  const re = /wx\.(navigateTo|redirectTo|reLaunch|switchTab)\s*\(\s*\{([\s\S]{0,240}?)\}/g;
  let m;
  while ((m = re.exec(js))) {
    const api = m[1];
    const urlPart = /\burl\s*:\s*([\s\S]*)$/.exec(m[2]);
    if (!urlPart) continue;
    const raw = urlPart[1].trim();
    const lit = /^['"`](.*?)['"`]/.exec(raw);
    if (!lit) {
      out.push({ api, url: null, unknown: true });
      continue;
    }
    const str = lit[1];
    const rest = raw.slice(lit[0].length).trim();
    // 字面量之后还有拼接，且字面量里没有 '?' 作为路径/参数的分界 → 路径本身是拼出来的
    if (rest.startsWith('+') && !str.includes('?')) {
      out.push({ api, url: null, unknown: true });
      continue;
    }
    out.push({ api, url: str.split('?')[0].replace(/^\//, ''), unknown: false });
  }
  return out;
}

/** 是否调用过 wx.navigateBack */
export function hasNavBack(js) {
  return /wx\.navigateBack\s*\(/.test(js);
}

/** 从 s[start]（必须是 '{'）起做括号配平，返回内部文本 */
function braceBody(s, start) {
  if (s[start] !== '{') return '';
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (!depth) return s.slice(start + 1, i);
    }
  }
  return '';
}

/**
 * 解析「指定的 handler 名 → 跳转目标页」。
 *
 * 为什么必须传入 handler 名单、而不是盲扫 js 里所有方法：
 * 盲扫时 `Page({` 这种**函数调用**会被误认成方法定义（`Page` 后面 `(` 到第一个 `)` 之间
 * 正好跨过了第一个方法名），而且匹配会把后面的 handler 一起吞掉、导致真正的入口漏掉。
 * 只按 wxml 里实际出现的 handler 名精确查找，就没有这个问题。
 *
 * 只认方法体内**直接的**导航调用字面量 url；动态拼接的忽略（宁可不点，也不乱点）。
 *
 * @param {string} js 页面 js 源码
 * @param {string[]} handlers wxml 里 bindtap/catchtap 的方法名
 * @returns {Record<string,{api:string,url:string}>}
 */
export function methodNavMap(js, handlers) {
  const out = {};
  const names = [...new Set((handlers || []).filter((h) => /^[A-Za-z_$][\w$]*$/.test(h)))];
  for (const name of names) {
    const re = new RegExp('(?:^|[^\\w$.])' + name + '\\s*(?::\\s*(?:async\\s+)?function\\s*)?\\([^)]*\\)\\s*\\{', 'g');
    let m;
    while ((m = re.exec(js))) {
      const body = braceBody(js, m.index + m[0].length - 1);
      if (!body) continue;
      const hit = navCalls(body).find((c) => !c.unknown && c.url);
      if (hit) {
        out[name] = { api: hit.api, url: hit.url };
        break;
      }
    }
  }
  return out;
}

/** 归一化页面路径：去掉开头的 / 和结尾的 .js/.wxml */
export function normPage(p) {
  return String(p || '').replace(/^\//, '').replace(/\.(js|wxml|wxss|json)$/, '');
}

/**
 * 纯函数：按「点几下」算每个页面的进出成本。可离线自检。
 *
 * @param {{pages:string[], tabPages:string[], home:string,
 *          edges:Record<string,string[]>, backs:Record<string,boolean>,
 *          taps:Record<string,Array>}} g
 */
export function computeCost(g) {
  const pages = g.pages.map(normPage);
  const tabPages = new Set((g.tabPages || []).map(normPage));
  const home = normPage(g.home || pages[0]);
  const edges = {};
  for (const [k, v] of Object.entries(g.edges || {})) edges[normPage(k)] = v.map(normPage);
  const backs = {};
  for (const [k, v] of Object.entries(g.backs || {})) backs[normPage(k)] = !!v;

  // 从首页出发的 BFS：navigateTo 一条边算 1 次点击；任何 tab 页从首页点一下也能直达
  const dist = { [home]: 0 };
  const queue = [home];
  const via = {};
  while (queue.length) {
    const cur = queue.shift();
    const next = [...(edges[cur] || [])];
    for (const t of tabPages) if (t !== cur) next.push(t);
    for (const n of next) {
      if (!pages.includes(n)) continue;
      if (dist[n] === undefined) {
        dist[n] = dist[cur] + 1;
        via[n] = cur;
        queue.push(n);
      }
    }
  }

  const list = pages.map((p) => {
    const entry = dist[p] === undefined ? null : dist[p];
    const isTab = tabPages.has(p);
    // 回首页：tab 页→点一下首页 tab；非 tab 页→按进入深度逐层 navigateBack；
    // 没有 navigateBack 又不在 tab 里，就只能靠系统返回箭头/手势
    let back = null;
    let backKind = '';
    if (p === home) {
      back = 0;
      backKind = '本来就是首页';
    } else if (isTab) {
      back = 1;
      backKind = '点底部 tab 直达';
    } else if (backs[p] && entry !== null) {
      back = entry;
      backKind = '逐层返回（每层一次）';
    } else {
      backKind = '没有显式返回调用，只能靠系统返回箭头/手势';
    }

    let level = 'ok';
    let note = '';
    if (entry === null) {
      level = 'unreachable';
      note = '没有任何入口，用户到不了这一页';
    } else if (back === null) {
      level = 'hard';
      note = backKind;
    } else if (back >= 3) {
      level = 'hard';
      note = '回首页要点 ' + back + ' 次';
    } else if (back === 2) {
      level = 'so-so';
      note = '回首页要点 2 次';
    }

    return {
      page: p,
      entryTaps: entry,
      backTaps: back,
      isTab,
      backKind,
      level,
      note,
      tapCount: (g.taps && g.taps[p] ? g.taps[p].length : 0),
      taps: (g.taps && g.taps[p]) || [],
    };
  });

  list.sort((a, b) => (a.entryTaps ?? 99) - (b.entryTaps ?? 99) || a.page.localeCompare(b.page));

  return {
    home,
    tabPages: [...tabPages],
    pages: list,
    totals: {
      pages: pages.length,
      unreachable: list.filter((p) => p.level === 'unreachable').length,
      hard: list.filter((p) => p.level === 'hard').length,
      deepest: Math.max(0, ...list.map((p) => p.entryTaps ?? 0)),
    },
  };
}

/** 读工程并算出操作成本报告 */
export function analyzeNavCost(project) {
  const app = readJson(path.join(project, 'app.json'));
  if (!app || !Array.isArray(app.pages) || !app.pages.length) {
    throw new Error('app.json 缺失或 pages 为空，无法分析操作成本');
  }
  const pages = app.pages.map(normPage);
  const tabPages = ((app.tabBar && app.tabBar.list) || []).map((t) => normPage(t.pagePath));

  const edges = {};
  const backs = {};
  const taps = {};
  const dynamic = [];
  // 「点哪个元素会跳到哪一页」——只有这些元素才允许被真点击（避免误点清空数据之类的按钮）
  const edgeDetails = [];
  for (const p of pages) {
    const js = readText(path.join(project, p + '.js'));
    const wxml = readText(path.join(project, p + '.wxml'));
    taps[p] = tapTargets(wxml);
    backs[p] = hasNavBack(js);
    const calls = navCalls(js);
    edges[p] = [];
    for (const c of calls) {
      if (c.unknown || !c.url) {
        dynamic.push({ page: p, reason: '动态拼接的 url，静态解析不了' });
        continue;
      }
      if (!edges[p].includes(c.url)) edges[p].push(c.url);
    }
    const map = methodNavMap(js, taps[p].map((t) => t.handler));
    for (const t of taps[p]) {
      const nav = map[t.handler];
      if (!nav) continue;
      edgeDetails.push({
        from: p,
        handler: t.handler,
        classes: t.classes,
        text: t.text,
        api: nav.api,
        to: nav.url,
      });
    }
  }

  const report = computeCost({ pages, tabPages, home: pages[0], edges, backs, taps });
  report.dynamic = dynamic;
  report.edgeDetails = edgeDetails;
  return report;
}
