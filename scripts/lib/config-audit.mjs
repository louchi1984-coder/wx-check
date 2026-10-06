/**
 * 模块 A：工程配置与资源完整性体检（纯静态，不需要开发者工具，不需要登录）
 *
 * 判据分两级：
 *   P0 客观错误   —— 会导致编译失败、白屏或功能不可用（页面文件缺失、组件引用失效……）
 *   P1 取舍/优化  —— 影响有限或修法不唯一，交用户定夺（按需注入、压缩、热重载……）
 *
 * 每一项都带 file/field 与具体改法，AI 可直接据此修改，不需要用户去点界面按钮。
 */
import fs from 'fs';
import path from 'path';

const walkFiles = (dir, out = [], depth = 0) => {
  if (depth > 6 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'miniprogram_npm' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out, depth + 1);
    else out.push(p);
  }
  return out;
};

const readJson = (file) => {
  if (!fs.existsSync(file)) return { exists: false, data: null, err: null };
  try {
    return { exists: true, data: JSON.parse(fs.readFileSync(file, 'utf8')), err: null };
  } catch (e) {
    return { exists: true, data: null, err: e.message };
  }
};

const IMG_EXT = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;

export function auditConfig(project) {
  const issues = [];
  const add = (level, rule, where, msg, fix, autofix = false) =>
    issues.push({ level, rule, where, msg, fix, autofix });

  const pc = readJson(path.join(project, 'project.config.json'));
  const ppc = readJson(path.join(project, 'project.private.config.json'));
  const common = (pc.data && pc.data.setting) || {};
  const priv = (ppc.data && ppc.data.setting) || {};
  const eff = { ...common, ...priv };
  const miniprogramRoot = String((pc.data && pc.data.miniprogramRoot) || '').replace(/^\.\//, '');
  const SRC = path.resolve(project, miniprogramRoot || '.');
  const pcPath = 'project.config.json';
  const pvPath = 'project.private.config.json';

  const appFile = path.join(SRC, 'app.json');
  const appR = readJson(appFile);
  if (!appR.exists) {
    add('P0', '工程不完整', 'app.json', '找不到 app.json，目标目录不是小程序工程', '确认 --project 指向包含 app.json 的目录');
    return { issues, stats: { pages: 0, components: 0 } };
  }
  if (appR.err) {
    add('P0', 'app.json 语法错误', 'app.json', 'JSON 解析失败: ' + appR.err, '修复 JSON 语法（多余逗号、注释、单引号）');
    return { issues, stats: { pages: 0, components: 0 } };
  }
  const app = appR.data || {};

  // ── 页面清单 ────────────────────────────────────────────────
  const mainPages = (app.pages || []).map((p) => String(p).replace(/^\//, ''));
  const subs = app.subPackages || app.subpackages || [];
  const subPages = [];
  for (const sp of subs) {
    const root = String(sp.root || '').replace(/\/$/, '');
    if (!fs.existsSync(path.join(SRC, root))) {
      add('P0', '分包目录缺失', 'app.json', `分包 root "${root}" 目录不存在`, `创建目录 ${root}/，或从 subPackages 中移除该分包`);
    }
    for (const p of sp.pages || []) subPages.push(root + '/' + String(p).replace(/^\//, ''));
  }
  const allPages = [...mainPages, ...subPages];

  // 页面路径重复
  const dup = allPages.filter((p, i) => allPages.indexOf(p) !== i);
  if (dup.length) {
    add('P0', '页面路径重复', 'app.json', `pages 中重复登记: ${[...new Set(dup)].join(', ')}`, '删除重复项（保留一份）', true);
  }

  // 页面文件缺失
  const missing = [];
  for (const p of allPages) {
    const lacks = ['.wxml', '.js'].filter((e) => !fs.existsSync(path.join(SRC, p + e)));
    if (lacks.length) missing.push(p + '（缺 ' + lacks.join('、') + '）');
  }
  if (missing.length) {
    add('P0', '页面文件缺失', 'app.json', `${missing.length} 个页面缺文件: ${missing.slice(0, 6).join('、')}${missing.length > 6 ? ' 等' : ''}`, '补建缺失文件，或从 app.json 的 pages 中移除该页面');
  }

  // ── tabBar ─────────────────────────────────────────────────
  const tb = app.tabBar;
  if (tb) {
    if (tb.custom === true) {
      const base = path.join(SRC, 'custom-tab-bar', 'index');
      if (!['.js', '.wxml', '.json'].some((e) => fs.existsSync(base + e))) {
        add('P0', '自定义 TabBar 缺失', 'app.json', 'tabBar.custom 为 true，但找不到 custom-tab-bar/index 组件', '创建 custom-tab-bar/index 组件，或把 tabBar.custom 改回 false');
      }
    }
    const tbMissing = [];
    for (const item of tb.list || []) {
      const pp = String(item.pagePath || '').replace(/^\//, '');
      if (pp && !mainPages.includes(pp)) tbMissing.push(pp);
      for (const k of ['iconPath', 'selectedIconPath']) {
        const v = item[k];
        if (v && !/^https?:/.test(v) && !fs.existsSync(path.join(SRC, String(v).replace(/^\//, '')))) {
          add('P0', 'TabBar 图标缺失', 'app.json', `tabBar.list 中 ${k} 指向的文件不存在: ${v}`, `补上该图片，或删除 ${k} 字段`);
        }
      }
    }
    if (tbMissing.length) {
      add('P0', 'TabBar 页面未注册', 'app.json', `tabBar.list 的 pagePath 不在 pages 中: ${[...new Set(tbMissing)].join('、')}`, '把这些页面补进 app.json 的 pages（tabBar 页面必须在主包）');
    }
  }

  // ── 组件引用（全局 + 页面级） ────────────────────────────────
  const resolveLocal = (v, fromDir) => {
    const s = String(v).trim();
    if (/^plugin:\/\//.test(s) || /^wx-/.test(s)) return null; // 插件 / 内置组件
    if (s.startsWith('/')) return path.join(SRC, s);
    if (s.startsWith('./') || s.startsWith('../')) return path.resolve(fromDir, s);
    return path.join(SRC, s); // miniprogram_npm/... 等
  };
  const compExists = (base) =>
    ['.json', '.js', '.wxml'].some((e) => fs.existsSync(base + e)) ||
    ['index.json', 'index.js', 'index.wxml'].some((e) => fs.existsSync(path.join(base, e)));

  let compChecked = 0;
  // 检查所有 json（app.json、各页面 json、自定义组件 json）里的 usingComponents
  const jsonFiles = walkFiles(SRC).filter((f) => f.endsWith('.json'));
  const compSources = [{ file: 'app.json', dir: SRC, uc: app.usingComponents }];
  for (const f of jsonFiles) {
    const rel = path.relative(SRC, f);
    if (rel === 'app.json') continue;
    const uc = readJson(f).data?.usingComponents;
    if (uc) compSources.push({ file: rel, dir: path.dirname(f), uc });
  }

  for (const src of compSources) {
    for (const [name, val] of Object.entries(src.uc || {})) {
      const base = resolveLocal(val, src.dir);
      if (!base) continue;
      compChecked++;
      if (!compExists(base)) {
        add('P0', '组件引用失效', src.file, `usingComponents["${name}"] → ${val} 解析不到实体文件`, '修正路径，或删除该组件声明（若已改用 npm 构建，先跑 build_npm）');
      }
    }
  }

  // ── wxml 内的 import / include 与本地图片 ────────────────────
  const wxmlFiles = walkFiles(SRC).filter((f) => f.endsWith('.wxml'));
  const imgMissing = [];
  for (const f of wxmlFiles) {
    const s = fs.readFileSync(f, 'utf8');
    const rel = path.relative(SRC, f);
    for (const m of s.matchAll(/<(?:import|include)\s+src="([^"]+)"/g)) {
      const t = resolveLocal(m[1], path.dirname(f));
      if (t && !fs.existsSync(t)) add('P0', '模板引用失效', rel, `${m[0].slice(0, 40)}… 指向的文件不存在`, '修正 src 路径');
    }
    for (const m of s.matchAll(/(?:src|url\()\s*=?\s*["'(]([^"')\s]+\.(?:png|jpe?g|gif|svg|webp))["')]/gi)) {
      const v = m[1];
      if (v.includes('{{') || /^https?:/.test(v) || v.startsWith('data:')) continue;
      const t = path.join(SRC, v.replace(/^\//, ''));
      if (!fs.existsSync(t)) imgMissing.push(`${rel} → ${v}`);
    }
  }
  if (imgMissing.length) {
    add('P1', '图片资源缺失', '各页面 wxml', `${imgMissing.length} 处引用的本地图片不存在: ${imgMissing.slice(0, 4).join('；')}${imgMissing.length > 4 ? ' 等' : ''}`, '补齐图片，或修正路径', false);
  }

  // ── 配置项体检（可定夺） ─────────────────────────────────────
  if (app.lazyCodeLoading !== 'requiredComponents') {
    add('P1', '组件按需注入', 'app.json', '未启用组件按需注入（当前值: ' + (app.lazyCodeLoading ?? '未设置') + '）', '在 app.json 增加 "lazyCodeLoading": "requiredComponents"；可减小启动包与首屏耗时，但动态创建的组件需改为显式声明');
  }
  if (common.es6 !== undefined && common.enhance !== undefined && common.es6 !== common.enhance) {
    add('P1', '编译开关不同步', pcPath + ' → setting', `es6=${common.es6} 与 enhance=${common.enhance} 不一致`, 'es6 与 enhance 必须同开同关，按需要统一为 true 或 false');
  }
  const minifyOff = ['minified', 'minifyWXSS', 'minifyWXML'].filter((k) => common[k] === false);
  if (minifyOff.length) {
    add('P1', '上传未压缩', pcPath + ' → setting', `以下项为 false: ${minifyOff.join(', ')}`, `把 ${minifyOff.join(' / ')} 改为 true（影响上传包体积，不影响本地调试）`);
  }
  if (eff.compileHotReLoad !== true) {
    add('P1', '未开热重载', pvPath + ' → setting', 'compileHotReLoad 未开启', '在 ' + pvPath + ' 设置 "compileHotReLoad": true，改代码后自动刷新，属本机偏好');
  }
  if (eff.urlCheck === true) {
    add('P1', '域名校验', pvPath + ' → setting', 'urlCheck 为 true，开发期请求未配置的域名会被拦截', '开发期可在 ' + pvPath + ' 设 "urlCheck": false；上线前务必还原（生产以平台配置为准）');
  }
  const libVersion = (pc.data && pc.data.libVersion) || eff.libVersion;
  if (!libVersion) {
    add('P1', '基础库未指定', pcPath, '未指定 libVersion，不同机器可能跑在不同基础库上', '在 ' + pcPath + ' 指定 "libVersion"，与团队对齐');
  }
  const appid = (ppc.data && ppc.data.appid) || (pc.data && pc.data.appid);
  if (!appid) {
    add('P1', 'AppID 缺失', pcPath + ' / ' + pvPath, '未配置 appid，无法预览、上传或使用云能力', '填入 appid，或使用测试号（touristappid）仅做本地调试');
  } else if (appid === 'touristappid') {
    add('P1', 'AppID 为测试号', pcPath, 'appid 为 touristappid（测试号）', '本地调试可用；要预览 / 上传 / 云开发需换成正式 AppID');
  }
  const sitemapLoc = String(app.sitemapLocation || 'sitemap.json').replace(/^\//, '');
  if (!fs.existsSync(path.join(SRC, sitemapLoc))) {
    add('P1', 'Sitemap 缺失', 'app.json', `sitemapLocation 指向 ${sitemapLoc}，该文件不存在`, `创建 ${sitemapLoc}（最小内容 {"rules":[{"action":"allow","page":"*"}]}），或删除 sitemapLocation 字段`);
  }
  if (mainPages.length > 20 && !subs.length) {
    add('P1', '建议分包', 'app.json', `主包 ${mainPages.length} 个页面且未分包，主包体积容易超限`, '按功能拆出 subPackages，把低频页面移入分包');
  }

  // ── 孤儿页面（有 Page() 但未登记） ───────────────────────────
  const orphans = [];
  for (const f of wxmlFiles) {
    const rel = path.relative(SRC, f).replace(/\.wxml$/, '');
    if (allPages.includes(rel)) continue;
    const js = path.join(SRC, rel + '.js');
    if (!fs.existsSync(js)) continue;
    if (!/\bPage\s*\(/.test(fs.readFileSync(js, 'utf8'))) continue;
    orphans.push(rel);
  }
  if (orphans.length) {
    add('P1', '孤儿页面', 'app.json', `${orphans.length} 个页面写了 Page() 但未在 app.json 登记: ${orphans.slice(0, 5).join('、')}${orphans.length > 5 ? ' 等' : ''}`, '确认是否需要；不用则删除，需要则登记进 pages');
  }

  return {
    issues,
    stats: {
      pages: allPages.length,
      mainPages: mainPages.length,
      subPackages: subs.length,
      components: compChecked,
      wxml: wxmlFiles.length,
      src: path.relative(project, SRC) || '.',
    },
  };
}
