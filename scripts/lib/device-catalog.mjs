/** 只读机型目录：使用开发者工具 hash_key_map 的 toolbar_<项目路径> 映射。 */
import fs from 'fs';
import path from 'path';
import os from 'os';

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

/** 精确定位项目 toolbar 配置；找不到或多个用户目录有同一项目时拒绝读取。 */
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
  if (candidates.size !== 1) throw new Error('目标项目机型配置不能唯一定位（' + candidates.size + ' 个），未读取配置');
  const file = [...candidates][0];
  const d = readJson(file);
  if (!Array.isArray(d?.device?.list) || !d.device.list[d.device.current]) throw new Error('目标项目机型配置无效');
  return file;
}

export function projectDeviceTable(project, root = APP_SUPPORT) {
  const d = readJson(findProjectDeviceFile(project, root));
  return d.device.list.map((x, index) => ({ ...x, index }));
}
