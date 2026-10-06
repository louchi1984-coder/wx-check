/** 单项目机型切换：使用开发者工具 hash_key_map 的 toolbar_<项目路径> 映射。 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { wechatide } from './wechatide.mjs';

const APP_SUPPORT = process.env.WECHATIDE_DATA_DIR || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', '微信开发者工具') : null);
function requireDataRoot(root) { if (!root) throw Error('未发现当前平台工具数据目录；请按实际安装设置 WECHATIDE_DATA_DIR'); return root; }

/** 找出全部 localstorage_*.json（含不带 device 状态的，后面按内容过滤） */
export function findDeviceFiles(root = APP_SUPPORT) {
  requireDataRoot(root);
  const out = [];
  let hashes = [];
  try { hashes = fs.readdirSync(root); } catch { return out; }
  for (const hash of hashes) {
    const dir = path.join(root, hash, 'WeappLocalData');
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (f.startsWith('localstorage_') && f.endsWith('.json')) out.push(path.join(dir, f));
    }
  }
  return out;
}

/** 从任一配置文件读机型表 [{index,name,desc,type}]；读不到返回 null */
export function deviceTable(root = APP_SUPPORT) {
  for (const f of findDeviceFiles(root)) {
    try {
      const d = readJson(f);
      if (d && d.device && Array.isArray(d.device.list)) {
        return d.device.list.map((x, i) => ({ index: i, name: x.name || '', desc: x.desc || '', type: x.type || '' }));
      }
    } catch { /* 换下一个文件 */ }
  }
  return null;
}

function readJson(f) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  return typeof d === 'object' && d && !Array.isArray(d) ? d : null;
}

/** 从 desc「320 x 568 | Dpr:2」里抠宽高 */
export function sizeOf(desc) {
  const m = /(\d+)\s*[x×*]\s*(\d+)/.exec(String(desc || ''));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * 纯函数：把「320」「320x568」「iPhone 5」「iPad」解析成机型表里的一项。
 * 尺寸优先于名称；同尺寸多个机型取宽度最小（最严苛）的。找不到返回 null。
 */
export function parseDeviceSpec(spec, table) {
  const s = String(spec || '').trim().toLowerCase();
  if (!s || !Array.isArray(table) || !table.length) return null;

  const m = /^(\d{2,4})(?:\s*[x×*]\s*(\d{2,5}))?$/.exec(s);
  if (m) {
    const w = Number(m[1]);
    const h = m[2] ? Number(m[2]) : null;
    const hits = table.filter((x) => {
      const sz = sizeOf(x.desc);
      return sz && sz.width === w && (h === null || sz.height === h);
    });
    if (hits.length) {
      hits.sort((a, b) => sizeOf(a.desc).width - sizeOf(b.desc).width);
      return hits[0];
    }
  }

  const byName = table.filter((x) => x.name.toLowerCase().includes(s) && (!x.type || x.type === 'default'));
  if (byName.length) {
    byName.sort((a, b) => (sizeOf(a.desc)?.width || 9999) - (sizeOf(b.desc)?.width || 9999));
    return byName[0];
  }
  return null;
}

/** 精确定位项目 toolbar 配置；找不到或多个用户目录有同一项目时拒绝写入。 */
export function findProjectDeviceFile(project, root = APP_SUPPORT) {
  requireDataRoot(root);
  const wanted = 'toolbar_' + path.resolve(project).replace(/[\\/]+$/, '');
  const candidates = new Set();
  for (const hash of fs.readdirSync(root)) {
    const dir = path.join(root, hash, 'WeappLocalData');
    for (const name of ['hash_key_map.json', 'hash_key_map_2.json']) {
      let map;
      try { map = readJson(path.join(dir, name)); } catch { continue; }
      for (const [key, value] of Object.entries(map || {})) {
        if (value !== wanted || !/^[a-f0-9]{32}$/.test(key)) continue;
        const current = path.join(dir, 'ls_' + key + '.json');
        const old = path.join(dir, 'localstorage_' + key + '.json');
        const file = fs.existsSync(current) ? current : old;
        if (fs.existsSync(file)) candidates.add(file);
      }
    }
  }
  if (candidates.size !== 1) throw new Error('目标项目机型配置不能唯一定位（' + candidates.size + ' 个），未修改任何配置');
  const file = [...candidates][0];
  const d = readJson(file);
  if (!Array.isArray(d?.device?.list) || !d.device.list[d.device.current]) throw new Error('目标项目机型配置无效');
  return file;
}

export function projectDeviceTable(project, root = APP_SUPPORT) {
  const d = readJson(findProjectDeviceFile(project, root));
  return d.device.list.map((x, index) => ({ ...x, index }));
}

function writeJson(file, data) {
  const temp = file + '.ui-device-' + process.pid + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(data), { mode: fs.statSync(file).mode }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

/** 调用前须关闭目标窗口。旧的跨项目调用签名不再允许。 */
export function patchDevice(spec, opts = {}) {
  if (!opts.project) throw new Error('必须指定 project，禁止跨项目切换');
  const file = findProjectDeviceFile(opts.project, opts.root);
  const d = readJson(file);
  const table = d.device.list.map((x, index) => ({ ...x, index }));
  const hit = parseDeviceSpec(spec, table);
  if (!hit) throw new Error('目标项目没有机型：' + spec);
  d.device.current = hit.index;
  d.deviceInfo = structuredClone(hit.info || {});
  writeJson(file, d);
  return { ...hit, file, patched: 1 };
}

export function waitDeviceReady(project, device, opts = {}) {
  const call = opts.call || wechatide;
  const attempts = [];
  let previous = null;
  for (let n = 0; n < 4; n++) {
    let data;
    const start = Date.now();
    try {
      const r = call('automation_evaluate', ['--project', project, '--fn-source',
        'function(){var ps=getCurrentPages();return {window:wx.getWindowInfo(),device:wx.getDeviceInfo(),route:ps[ps.length-1].route};}'], { timeout: 15000 });
      if (r?.ok === false || r?.result?.success === false) throw new Error(r.message || r.result?.error || '未就绪');
      data = r?.result?.result?.result;
      const w = data?.window;
      const match = w?.screenWidth === device.info.screenWidth && w?.screenHeight === device.info.screenHeight &&
        w?.pixelRatio === device.info.dpr && data?.device?.model === device.info.model && w.windowWidth > 0 && w.windowHeight > 0;
      const signature = match ? JSON.stringify([w.windowWidth,w.windowHeight,w.screenWidth,w.screenHeight,w.pixelRatio,data.device.model]) : null;
      attempts.push({ ms: Date.now()-start, match: !!match });
      if (signature && previous === signature) return { info: data, attempts };
      previous = signature;
    } catch (e) { previous = null; attempts.push({ ms: Date.now()-start, error: e.message }); }
  }
  const e = new Error('目标机型未在四次探测内稳定：' + device.name);
  e.attempts = attempts;
  throw e;
}

/** 一次批量运行共用一个备份，finally 调用 restore；只恢复机型字段，不覆盖其他设置。 */
export function createDeviceSession(project, opts = {}) {
  const call = opts.call || wechatide;
  const root = opts.root || APP_SUPPORT;
  if (!opts.backupDir) throw new Error('需要工程外 backupDir');
  const relative = path.relative(path.resolve(project), path.resolve(opts.backupDir));
  if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw new Error('备份目录必须在工程外');
  findProjectDeviceFile(project, root);
  let original = null, opened = true, originalRoute = null;
  const originals = new Map();
  const backupFile = path.join(opts.backupDir, 'device-backup.json');
  function invoke(tool, args = []) {
    const r = call(tool, ['--project', project, ...args], { timeout: 45000 });
    if (!r || r.ok === false || r.result?.success === false) throw new Error(r?.message || r?.result?.error || tool + ' 失败');
    return r;
  }
  function close() { if (opened) { invoke('close_project_window'); opened = false; } }
  function open() { opened = true; invoke('open_project_window', ['--window-mode', 'fullMode']); }
  function save(file) {
    const d = readJson(file);
    if (!original && fs.existsSync(backupFile)) throw new Error('已有机型备份，请使用新的输出目录：' + backupFile);
    if (!original) original = { current: d.device.current, deviceInfo: structuredClone(d.deviceInfo), selected: structuredClone(d.device.list[d.device.current]) };
    if (!originals.has(file)) originals.set(file, d);
    fs.mkdirSync(opts.backupDir, {recursive:true});
    fs.writeFileSync(backupFile, JSON.stringify({ project, original, originalRoute, files: Object.fromEntries(originals) }, null, 2));
  }
  return {
    backupFile,
    switchTo(spec) {
      if (!original && originalRoute === null) {
        const r = invoke('automation_evaluate', ['--fn-source', 'function(){var ps=getCurrentPages();return ps[ps.length-1].route;}']);
        originalRoute = r.result?.result?.result;
        if (typeof originalRoute !== 'string' || !originalRoute) throw new Error('无法读取原页面，尚未关闭窗口');
      }
      close();
      const file = findProjectDeviceFile(project, root);
      save(file);
      const hit = patchDevice(spec, { project, root });
      open();
      const ready = waitDeviceReady(project, hit, {call});
      return { ...hit, readiness: ready.attempts, runtime: ready.info };
    },
    restore() {
      if (!original) { if (!opened) open(); return { changed: false }; }
      close();
      const current = findProjectDeviceFile(project, root);
      for (const file of new Set([...originals.keys(), current])) {
        const d = readJson(file);
        const index = d.device.list.findIndex(x => x.name === original.selected.name && JSON.stringify(x.info) === JSON.stringify(original.selected.info));
        if (index < 0) throw new Error('原机型在列表中不存在，保留备份：' + backupFile);
        d.device.current = index;
        d.deviceInfo = structuredClone(original.deviceInfo);
        writeJson(file, d);
      }
      open();
      const ready = waitDeviceReady(project, original.selected, {call});
      if (originalRoute) {
        const app = JSON.parse(fs.readFileSync(path.join(project, 'app.json'), 'utf8'));
        const tabs = app.tabBar?.list?.map(x => x.pagePath) || [];
        invoke('automation_navigate', ['--action', tabs.includes(originalRoute) ? 'switchTab' : 'reLaunch', '--url', '/' + originalRoute]);
        const r = invoke('automation_evaluate', ['--fn-source', 'function(){var ps=getCurrentPages();return ps[ps.length-1].route;}']);
        if (r.result?.result?.result !== originalRoute) throw new Error('机型已恢复，但原页面恢复未验证');
      }
      return { restored: true, device: original.selected.name, page: originalRoute, readiness: ready.attempts };
    },
  };
}
