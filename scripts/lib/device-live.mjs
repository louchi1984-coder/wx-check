/** 复用项目窗口的本机 CDP 通道，调用工具自己的切换动作及 Automator 桥接。 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MODULES = (process.env.WECHATIDE_MODULES_DIR || '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar/js/').replace(/[\\/]+$/, '') + '/';
const STORE = MODULES + '046aafa51723e0b9f12bd58599007fec.js';
const ACTIONS = MODULES + '2ecffceebb5231b0b30aa91a6000cc89.js';
const SERVICES = MODULES + '9eee66f818065fa6881814a83bcfe0cf.js';
const BRIDGE = MODULES + '7c6904c45555b535152eb890ace1ac1e.js';
const RUNTIME = 'function(){var ps=getCurrentPages();return {window:wx.getWindowInfo(),device:wx.getDeviceInfo(),route:ps[ps.length-1].route};}';
const outside = (project, dir) => {
  const relative = path.relative(project, path.resolve(dir));
  if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw Error('备份及截图必须在工程之外');
};

async function connect(url) {
  const ws = new WebSocket(url), pending = new Map(); let id = 0;
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data), entry = pending.get(data.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(data.id);
    data.error ? entry.reject(Error(data.error.message)) : entry.resolve(data.result);
  });
  ws.addEventListener('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('项目调试连接已关闭')); }
    pending.clear();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Error('项目调试连接超时')); }, 5000);
    ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('项目调试连接失败')); }, { once: true });
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  return { close: () => ws.close(), async evaluate(expression, timeout = 15000) {
    const requestId = ++id;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(Error('窗口脚本调用超时')); }, timeout);
      pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  } };
}

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
      const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw Error('HTTP ' + r.status);
      targets = await r.json();
    } catch (e) { throw Error('本机调试通道不可用，需先获得用户许可，一次性开启工具调试端口；不自动重启、不退回逐机型重开。原因：' + e.message); }
    const matching = targets.filter(x => {
      try { return x.type === 'page' && /\/electron-project(?:-lite)?\.html$/.test(new URL(x.url).pathname) && path.resolve(new URL(x.url).searchParams.get('projectpath') || '') === project; }
      catch { return false; }
    });
    if (matching.length !== 1) throw Error('无法唯一定位目标工程窗口：' + matching.length + ' 个');
    const url = new URL(matching[0].webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port) throw Error('拒绝连接非预期本机调试地址');
    client = await connect(url.href); targetId = matching[0].id;
  }
  const prefix = `const store=require(${JSON.stringify(STORE)}).default;const state=store.getState();if(state.project.current.projectpath!==${JSON.stringify(project)})throw Error('目标项目已改变');`;
  const evaluate = (body, timeout) => client.evaluate(`(async()=>{${prefix}${body}})()`, timeout);
  const sessionId = 'autocheck_' + randomUUID(); let sequence = 0, changed = false, original, originalRoute;
  async function request(method, params = {}, timeout = 10000) {
    const message = { id: sessionId + '_' + ++sequence, method, params };
    const raw = await evaluate(`const bridge=require(${JSON.stringify(SERVICES)}).default(require(${JSON.stringify(BRIDGE)}).IAutomatorBridgeService);return await bridge.request(${JSON.stringify(message)},${timeout});`, timeout + 500);
    const response = JSON.parse(raw);
    if (response.error) throw Error(response.error.message || '自动化调用失败');
    return response.result;
  }
  async function call(tool, args = [], options = {}) {
    const value = key => args[args.indexOf('--' + key) + 1];
    const timeout = options.timeout || 15000;
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
    await evaluate(`store.dispatch(require(${JSON.stringify(ACTIONS)}).default.selectDevice(${index}));return true;`);
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
