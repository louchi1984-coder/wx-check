import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { wechatide } from './wechatide.mjs';

function unwrap(value) {
  for (let i = 0; i < 6 && value && typeof value === 'object' && 'result' in value; i++) value = value.result;
  return value;
}
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
export function createStorageGuard(project, bin, opts = {}) {
  const call = opts.call || wechatide;
  const evaluate = fn => {
    const response = call('automation_evaluate', ['--project', project, '--fn-source', fn], { bin, timeout: 60000 });
    if (!response || response.ok === false || response.result?.success === false) throw Error(response?.message || '存储调用失败');
    const raw = unwrap(response);
    if (typeof raw !== 'string') throw Error('存储返回格式异常');
    const data = JSON.parse(raw);
    if (data.ok !== true) throw Error(data.error || '存储调用未成功');
    return data;
  };
  const read = () => {
    const data = evaluate(`function(){try{var seen=new Set();function valid(v){if(v===null||typeof v==='string'||typeof v==='boolean')return;if(typeof v==='number'&&Number.isFinite(v))return;if(typeof v!=='object'||seen.has(v))throw Error('存储含不可可靠备份的值');if(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)throw Error('存储值类型不支持');seen.add(v);Object.keys(v).forEach(function(k){valid(v[k])});seen.delete(v)}var d=Object.create(null);wx.getStorageInfoSync().keys.forEach(function(k){var v=wx.getStorageSync(k);valid(v);d[k]=v});return JSON.stringify({ok:true,entries:d})}catch(e){return JSON.stringify({ok:false,error:String(e)})}}`);
    if (!data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw Error('存储备份格式异常');
    return data.entries;
  };
  const original = read(); // 失败即终止，尚未发生任何业务操作或存储删除。
  const dir = opts.backupDir ? path.resolve(opts.backupDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'wx-check-storage-'));
  const relative = path.relative(path.resolve(project), dir);
  if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw Error('存储备份目录必须在工程外');
  fs.mkdirSync(dir, { recursive: true });
  const backupFile = path.join(dir, 'storage-backup.json');
  fs.writeFileSync(backupFile, JSON.stringify({ project, at: new Date().toISOString(), entries: original }, null, 2), { flag: 'wx', mode: 0o600 });
  return { backupFile, restore() {
    // 先保存恢复前状态；原键全部写回成功后才删除测试新增键。失败时保留两份恢复证据。
    const before = read();
    fs.writeFileSync(path.join(dir, 'before-restore.json'), JSON.stringify({ project, entries: before }, null, 2), { flag: 'wx', mode: 0o600 });
    const data = evaluate(`function(){try{var d=JSON.parse(${JSON.stringify(JSON.stringify(original))});Object.keys(d).forEach(function(k){wx.setStorageSync(k,d[k])});wx.getStorageInfoSync().keys.forEach(function(k){if(!Object.prototype.hasOwnProperty.call(d,k))wx.removeStorageSync(k)});return JSON.stringify({ok:true})}catch(e){return JSON.stringify({ok:false,error:String(e)})}}`);
    const restored = read();
    if (JSON.stringify(stable(restored)) !== JSON.stringify(stable(original))) throw Error('存储恢复后键或值不一致');
    return data.ok;
  } };
}
