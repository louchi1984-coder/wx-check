/** 复用项目窗口的本机 CDP 通道，调用工具自己的切换动作及 Automator 桥接。 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { discoverDeviceModules } from './diagnostic-modules.mjs';
import { readLocalTargets, connectLocalTarget } from './local-debug.mjs';

const MODULES = (process.env.WECHATIDE_MODULES_DIR || '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar/js/').replace(/[\\/]+$/, '') + '/';
const RUNTIME = 'function(){var ps=getCurrentPages();return {window:wx.getWindowInfo(),device:wx.getDeviceInfo(),route:ps[ps.length-1].route};}';
const outside = (project, dir) => {
  const relative = path.relative(project, path.resolve(dir));
  if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw Error('备份及截图必须在工程之外');
};

/** opts.transport 供回归测试模拟窗口；生产只连接 localhost，且只选择路径完全匹配的项目。 */
export async function createLiveDeviceSession(project, opts = {}) {
  project = path.resolve(project);
  if (!opts.backupDir) throw Error('需要工程外 backupDir');
  outside(project, opts.backupDir);
  const backupFile = path.join(opts.backupDir, 'device-backup.json');
  if (fs.existsSync(backupFile)) throw Error('已有机型备份，请使用新的输出目录：' + backupFile);
  const port = Number(opts.port || process.env.WECHATIDE_DEBUG_PORT || 9223);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('debug-port 必须为有效本机端口');
  let client = opts.transport, targetId = 'test';
  if (!client) {
    let targets;
    try {
      targets = await readLocalTargets(port);
    } catch (e) { throw Error('本机调试通道不可用，需先获得用户许可，一次性开启工具调试端口；不自动重启、不退回逐机型重开。原因：' + e.message); }
    const matching = targets.filter(x => {
      try { return x.type === 'page' && /\/electron-project(?:-lite)?\.html$/.test(new URL(x.url).pathname) && path.resolve(new URL(x.url).searchParams.get('projectpath') || '') === project; }
      catch { return false; }
    });
    if (matching.length !== 1) throw Error('无法唯一定位目标工程窗口：' + matching.length + ' 个');
    const url = new URL(matching[0].webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port) throw Error('拒绝连接非预期本机调试地址');
    client = await connectLocalTarget(matching[0],port); targetId = matching[0].id;
  }
  let modules;
  try {
    modules = opts.transport ? {store:'test-store',actions:'test-actions',services:'test-services',bridge:'test-bridge'} :
      await client.evaluate(`(()=>{const fs=require('fs'),path=require('path'),root=${JSON.stringify(MODULES)};const entries=fs.readdirSync(root).filter(f=>f.endsWith('.js')).map(file=>({file,source:fs.readFileSync(path.join(root,file),'utf8')}));return (${discoverDeviceModules.toString()})(entries);})()`);
  } catch(e) { client.close(); throw e; }
  const prefix = `const store=require(${JSON.stringify(MODULES+modules.store)}).default;const state=store.getState();if(state.project.current.projectpath!==${JSON.stringify(project)})throw Error('目标项目已改变');`;
  const evaluate = (body, timeout) => client.evaluate(`(async()=>{${prefix}${body}})()`, timeout);
  const sessionId = 'autocheck_' + randomUUID(); let sequence = 0, changed = false, original, originalRoute;
  async function request(method, params = {}, timeout = 10000) {
    const message = { id: sessionId + '_' + ++sequence, method, params };
    const raw = await evaluate(`const bridge=require(${JSON.stringify(MODULES+modules.services)}).default(require(${JSON.stringify(MODULES+modules.bridge)}).IAutomatorBridgeService);return await bridge.request(${JSON.stringify(message)},${timeout});`, timeout + 500);
    const response = JSON.parse(raw);
    if (response.error) throw Error(response.error.message || '自动化调用失败');
    return response.result;
  }
  async function call(tool, args = [], options = {}) {
    const value = key => args[args.indexOf('--' + key) + 1];
    const timeout = options.timeout || 15000;
    if (tool === 'automation_runtime_info' && value('action') === 'currentPage') {
      const page = await request('App.getCurrentPage', {}, timeout);
      return { ok: true, result: { success: true, currentPage: page } };
    }
    if (tool === 'automation_evaluate') {
      const result = await request('App.callFunction', { functionDeclaration: value('fn-source'), args: [] }, timeout);
      return { ok: true, result: { success: true, result } };
    }
    if (tool === 'automation_navigate') {
      const action = value('action');
      if (!['switchTab', 'reLaunch'].includes(action)) throw Error('不支持的 UI 导航：' + action);
      await request('App.callWxMethod', { method: action, args: [{ url: value('url') }] }, timeout);
      return { ok: true, result: { success: true } };
    }
    if (tool === 'simulator_screenshot') {
      const file = path.resolve(value('path')); outside(project, file);
      const result = await request('Tool.captureSimulatorScreenshot', {}, timeout);
      const data = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(result?.data || '');
      if (!data) throw Error('截图未返回 PNG/JPEG 图片');
      fs.writeFileSync(file, Buffer.from(data[2], 'base64'));
      return { ok: true, result: { success: true } };
    }
    throw Error('不支持的 UI 采集调用：' + tool);
  }
  const runtime = async timeout => (await call('automation_evaluate', ['--fn-source', RUNTIME], { timeout })).result.result.result;
  async function ready(device) {
    const attempts = []; let previous = null;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const start = Date.now();
      try {
        const data = await runtime(1000), w = data?.window;
        const match = w?.screenWidth === device.info.screenWidth && w?.screenHeight === device.info.screenHeight && w?.pixelRatio === device.info.dpr && data?.device?.model === device.info.model && w.windowWidth > 0 && w.windowHeight > 0;
        const signature = match ? JSON.stringify([w.windowWidth,w.windowHeight,w.screenWidth,w.screenHeight,w.pixelRatio,data.device.model]) : null;
        attempts.push({ ms: Date.now()-start, match: !!match, ...(match ? {} : { expected: device.info, actual: { screenWidth:w?.screenWidth, screenHeight:w?.screenHeight, pixelRatio:w?.pixelRatio, model:data?.device?.model } }) });
        if (signature && signature === previous) return { runtime: data, readiness: attempts };
        previous = signature;
      } catch (e) { previous = null; attempts.push({ ms: Date.now()-start, error: e.message }); }
      // 短间隔有界就绪探测，给渲染/系统切换时间；没有固定长等待。
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const e = Error('目标机型未在12秒内稳定：' + device.name); e.attempts = attempts; throw e;
  }
  async function select(index) {
    await evaluate(`store.dispatch(require(${JSON.stringify(MODULES+modules.actions)}).default.selectDevice(${index}));return true;`);
  }
  try {
    const state = await evaluate('return {current:state.toolbar.device.current,list:state.toolbar.device.list};');
    original = structuredClone(state.list[state.current]);
    if (!original?.info) throw Error('无法读取原机型，停止');
    originalRoute = (await runtime(10000)).route;
    if (!originalRoute) throw Error('无法读取原页面，停止');
    fs.mkdirSync(opts.backupDir, { recursive: true });
    fs.writeFileSync(backupFile, JSON.stringify({ project, targetId, original, originalRoute, mode: 'live' }, null, 2), { flag: 'wx' });
  } catch (e) { client.close(); throw e; }
  return {
    backupFile, call, close: () => client.close(),
    async switchTo(name) {
      const start = Date.now();
      const state = await evaluate('return {current:state.toolbar.device.current,list:state.toolbar.device.list};');
      const index = state.list.findIndex(x => x.name === name);
      if (index < 0) throw Error('目标项目没有机型：' + name);
      if (state.current !== index) { changed = true; await select(index); }
      return { ...state.list[index], index, ...await ready(state.list[index]), switchMs: Date.now()-start, mode: 'live', targetId };
    },
    async restore() {
      if (changed) {
        const state = await evaluate('return {current:state.toolbar.device.current,list:state.toolbar.device.list};');
        const index = state.list.findIndex(x => x.name === original.name && JSON.stringify(x.info) === JSON.stringify(original.info));
        if (index < 0) throw Error('原机型已不在列表中，保留备份：' + backupFile);
        if (state.current !== index) await select(index);
      }
      const restored = await ready(original);
      if (restored.runtime.route !== originalRoute) {
        const app = JSON.parse(fs.readFileSync(path.join(project, 'app.json')));
        await call('automation_navigate', ['--action', app.tabBar?.list?.some(x => x.pagePath === originalRoute) ? 'switchTab' : 'reLaunch', '--url', '/' + originalRoute]);
        if ((await runtime(10000)).route !== originalRoute) throw Error('机型已恢复，但原页面未恢复');
      }
      changed = false;
      return { restored: true, device: original.name, page: originalRoute, readiness: restored.readiness, mode: 'live', targetId };
    },
  };
}
