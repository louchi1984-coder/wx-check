#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLiveDeviceSession } from './lib/device-live.mjs';
import { scanUI } from './lib/ui-scan.mjs';
import { deviceTable, projectDeviceTable, createDeviceSession, parseDeviceSpec, sizeOf } from './lib/device-patch.mjs';

const argv = process.argv.slice(2);
const arg = (key, fallback = '') => { const i = argv.indexOf('--' + key); return i < 0 ? fallback : argv[i + 1]; };
const help = '自动批量：node ui-check.mjs --project <源码目录> --matrix --out <工程外目录>\n指定机型：node ui-check.mjs --project <源码目录> --devices \"HUAWEI Mate 80\" \"iPhone 15 Pro Max\" --out <工程外目录>\n用法：node ui-check.mjs --project <源码目录> --expected-size 320x568 --mode precise|minimal --out <工程外目录>\n计划：node ui-check.mjs --plan\n汇总：node ui-check.mjs --merge <报告1.json> <报告2.json> ... --out <汇总目录>';
function safeOut(project, dir) {
  const rel = path.relative(path.resolve(project), path.resolve(dir));
  if (!rel || (!rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) throw new Error('--out 必须在被测工程之外');
}
export function mergeIssues(reports) {
  const grouped = new Map();
  for (const r of reports) {
    const device = (r.device?.model || '当前机型') + ' ' + r.screen.width + '×' + r.screen.height;
    const entries = [...r.issues.map(i => ({ ...i, page: '全工程' })),
      ...r.pages.flatMap(p => p.issues.map(i => ({ ...i, page: p.page })))];
    for (const i of entries) {
      const key = [i.rule, i.page, (i.class || '').split(/\s+/).sort().join(' ')].join('|');
      if (!grouped.has(key)) grouped.set(key, { ...i, devices: [] });
      const item = grouped.get(key);
      if (!item.devices.includes(device)) item.devices.push(device);
      if (i.level === 'P0') item.level = 'P0';
    }
  }
  return [...grouped.values()];
}
function readable(reports) {
  const issues = mergeIssues(reports);
  const pictures = [...new Map(reports.flatMap(r => r.pages.filter(p => p.screenshot).map(p =>
    [p.screenshot, { page: p.page, device: r.device?.model || '当前机型', file: p.screenshot }]))).values()];
  return '# 界面检测结果\n\n' + reports.map(r => '- ' + (r.device?.model || '当前机型') + '（' + r.screen.width + '×' + r.screen.height + '）：' +
    (r.mode === 'precise' ? '精测采集' : '最小采集') + '，检查 ' + r.pages.filter(p => !p.error).length + ' 页' +
    (r.incomplete ? '，采集未完成，不能判为通过。' : '。')).join('\n') + '\n\n' +
    (issues.length ? '## 需要处理\n\n' + issues.map(i => '- ' + (i.rule === '触控区' ? '建议加大按钮点击区域' : '需要修复内容超出屏幕边缘') +
      '；位置：' + i.page + '；受影响机型：' + i.devices.join('、') + '。').join('\n') : '本次已采集的元素没有发现横向溢出或触控区偏小。') +
    '\n\n## 未覆盖\n\n本脚本只采集截图，尚未读图审阅布局感受。执行者须逐张审阅六款精测截图并补充结论。重叠、文字截断、按钮遮挡、滚动与键盘尚未完成核验。这里只报告几何采集结果，不表示完整 UI 测试通过。使用当前页面数据，没有自动写入测试账目。未执行的机型也不计为通过。\n' +
    reports.flatMap(r => r.pages.filter(p => p.error).map(p => '\n- 未完成：' + p.page + '，原因：' + p.error)).join('') + '\n' +
    (pictures.length ? '\n## 页面截图\n\n' + pictures.map(p => '### ' + p.device + ' · ' + p.page + '\n\n![' + p.page + '](' + p.file + ')\n').join('\n') : '\n本次没有截图证据；最小采集正常页面不截图，不能据此评价整体外观。\n') +
    reports.flatMap(r => r.pages.filter(p => p.screenshotError).map(p => '\n- 截图失败：' + p.page + '，' + p.screenshotError)).join('');
}
export function buildPlan(table) {
  const configured = process.env.WECHATIDE_PRECISE_MODELS ? JSON.parse(process.env.WECHATIDE_PRECISE_MODELS) : null;
  if (configured && (!Array.isArray(configured) || configured.length !== 6 || new Set(configured).size !== 6 || configured.some(x => typeof x !== 'string' || !x))) throw Error('WECHATIDE_PRECISE_MODELS 必须是六个不重复的本机机型全名JSON数组，顺序小小中中大大');
  const preferred = configured ? configured.map((name, i) => [name, ['小','小','中','中','大','大'][i]]) : [['HUAWEI Mate X6外','小'],['HUAWEI nova 14 Ultra','小'],['HUAWEI Mate 80','中'],['HUAWEI Mate 70 Pro','中'],['iPhone 15 Pro Max','大'],['HUAWEI Pura X Max内','大']];
  const selected = new Map();
  for (const [name, group] of preferred) {
    const hit = table.find(x => x.name === name && (!x.type || x.type === 'default'));
    if (!hit) throw new Error('本机缺少精测机型 ' + name + '，需要先调整精测机型计划');
    selected.set(hit.index, group);
  }
  return table.filter(x => !x.type || x.type === 'default').map(x => ({ name: x.name,
    size: sizeOf(x.desc), mode: selected.has(x.index) ? 'precise' : 'minimal', group: selected.get(x.index) || null }));
}
function valuesAfter(flag) {
  const start = argv.indexOf(flag) + 1;
  const end = argv.slice(start).findIndex(x => x.startsWith('--'));
  return argv.slice(start, end < 0 ? argv.length : start + end);
}
async function main() {
  if (argv.includes('--help')) { console.log(help); return; }
  const project = arg('project');
  if (argv.includes('--plan')) {
    const table = project ? projectDeviceTable(project) : deviceTable();
    if (!table) throw new Error('无法读取本机机型列表');
    console.log(JSON.stringify(buildPlan(table), null, 2));
    return;
  }
  const out = arg('out');
  if (!out) throw new Error(help);
  let reports = [], batch = null;
  if (argv.includes('--merge')) {
    const files = valuesAfter('--merge');
    if (!files.length) throw new Error('需要至少一份报告');
    reports = files.map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
    if (reports.some(r => r.project !== reports[0].project)) throw new Error('不能合并不同工程的报告');
    reports.forEach(r => safeOut(r.project, out));
  } else {
    if (!project || !fs.existsSync(path.join(project, 'app.json'))) throw new Error(help);
    safeOut(project, out);
    const options = { only: arg('page'), screenshot: argv.includes('--screenshot'), log: console.log };
    if (argv.includes('--matrix') || argv.includes('--devices') || argv.includes('--device')) {
      const table = projectDeviceTable(project);
      const plan = buildPlan(table);
      const specs = argv.includes('--matrix') ? plan.map(x => x.name) : argv.includes('--devices') ? valuesAfter('--devices') : [arg('device')];
      if (!specs.length) throw new Error('未指定机型');
      const selected = specs.map(spec => {
        const hit = parseDeviceSpec(spec, table);
        if (!hit) throw new Error('找不到机型：' + spec);
        const item = plan.find(x => x.name === hit.name);
        return { ...item, mode: arg('mode', item.mode) };
      });
      if (selected.some(x => !['minimal','precise'].includes(x.mode))) throw new Error('mode 必须为 minimal 或 precise');
      batch = { planned: selected, failures: [], restoration: null };
      const switchMode = arg('device-switch', 'live');
      if (!['live','restart'].includes(switchMode)) throw new Error('device-switch 必须为 live 或 restart');
      const session = switchMode === 'live'
        ? await createLiveDeviceSession(project, { backupDir: path.join(out, 'backup'), port: arg('debug-port', process.env.WECHATIDE_DEBUG_PORT || 9223) })
        : createDeviceSession(project, { backupDir: path.join(out, 'backup') });
      batch.switchMode = switchMode;
      try {
        for (const [index, item] of selected.entries()) {
          console.log('切换机型：' + item.name + '（' + item.mode + '）');
          try {
            const device = await session.switchTo(item.name);
            const dir = path.join(out, String(index+1).padStart(2,'0'));
            const r = { project: path.resolve(project), at: new Date().toISOString(),
              ...await scanUI(project, { ...options, ...(session.call ? {call:session.call} : {}), mode: item.mode, expectedSize: item.size,
                readyInfo: device.runtime, restorePage: false, screenshotDir: path.join(dir,'shots') }),
              readiness: device.readiness, switchMs: device.switchMs, switchMode, targetId: device.targetId, plannedDevice: item.name };
            reports.push(r);
            fs.mkdirSync(dir,{recursive:true});
            fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(r,null,2));
            fs.writeFileSync(path.join(dir,'report.md'),readable([r]));
            if (r.incomplete) break;
          } catch (e) { batch.failures.push({device:item.name,error:e.message,attempts:e.attempts}); break; }
        }
      } finally {
        try { batch.restoration = await session.restore(); }
        catch (e) { batch.restoration = { restored:false, error:e.message, backup:session.backupFile }; }
        finally { session.close?.(); }
      }
      batch.unvisited = selected.slice(reports.length + batch.failures.length).map(x=>x.name);
    } else {
      const size = /^(\d+)x(\d+)$/.exec(arg('expected-size'));
      if (!size) throw new Error(help);
      const r = await scanUI(project, { ...options, mode: arg('mode', 'minimal'),
        expectedSize: { width: Number(size[1]), height: Number(size[2]) }, screenshotDir: path.join(out, 'shots') });
      reports = [{ project: path.resolve(project), at: new Date().toISOString(), ...r }];
    }
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(batch ? { reports, ...batch, issues: mergeIssues(reports) } :
    reports.length === 1 ? reports[0] : { reports, issues: mergeIssues(reports) }, null, 2));
  let text = reports.length ? readable(reports) : '# 界面检测未完成\n\n没有页面完成采集，不能给出通过结论。\n';
  if (batch) text += '\n## 批量执行状态\n\n' +
    '- 切换方式：' + (batch.switchMode === 'live' ? '运行中切换，整批复用连接，不逐机型重开窗口。' : '旧兼容方式，逐机型重开窗口。') + '\n' +
    '- 计划 ' + batch.planned.length + ' 个机型，已采集 ' + reports.length + ' 个。\n' +
    '- 原机型／页面恢复：' + (batch.restoration?.restored ? '已验证恢复 ' + batch.restoration.device + '。' : '未验证恢复：' + (batch.restoration?.error || '未切换')) + '\n' +
    batch.failures.map(x=>'- 未完成：'+x.device+'，'+x.error+'。\n').join('') +
    (batch.unvisited.length ? '- 尚未执行：' + batch.unvisited.join('、') + '。\n' : '');
  fs.writeFileSync(path.join(out, 'report.md'), text);
  console.log('报告：' + path.resolve(out, 'report.md'));
  process.exitCode = batch && (batch.failures.length || batch.unvisited.length || !batch.restoration?.restored) || reports.some(r => r.incomplete) ? 2 : reports.some(r => r.totals.P0) ? 1 : 0;
}
// 可导入纯汇总函数做离线回归，不启动检测。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (e) { console.error(e.message); process.exitCode = 2; }
}
