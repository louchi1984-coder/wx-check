/**
 * 模块 C：运行时体检（需要开发者工具已打开项目且已登录）
 *
 * 读取小程序 console 与 network 缓冲区，筛出错误类记录。
 * 实测要点（照做才拿得到数据）：
 *   1. 必须先 simulator_refresh，再调一次 automation_evaluate —— automator 连接建立后
 *      console / network 缓冲区才开始回传；否则 grep 永远返回空字符串。
 *   2. command 必须是 grep；用 `grep -n .` 取全量。
 *   3. 返回格式：多行字符串，记录之间用 `--` 分隔，每行形如 `<行号>:<JSON>`。
 *
 * 判据：
 *   P0  console 的 error / uncaught；network 里 status 为 0 的失败请求
 *   P1  console 的 warn；HTTP 4xx / 5xx 响应
 */
import { wechatide, sleep, ensureReady } from './wechatide.mjs';

/**
 * 把 grep 返回的多行字符串切成记录。
 * 实测两种格式（务必都兼容）：
 *   console —— 记录之间用 `--` 独占一行分隔
 *   network —— 每条记录一行，无分隔符
 */
function parseRecords(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split('\n')
    .map((s) => s.replace(/^\s*\d+:/, '').replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((s) => s && s !== '--');
}

function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** console 记录形如 ["[error]","消息",...] */
function parseConsole(lines) {
  const out = [];
  for (const l of lines) {
    if (l.length > 2000) continue; // 超长堆栈单独处理
    const j = tryJson(l);
    if (!Array.isArray(j)) continue;
    const lvl = String(j[0] || '').replace(/[[\]]/g, '').toLowerCase();
    const msg = String(j[1] ?? '');
    const extra = j.slice(2).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    out.push({ level: lvl, msg: (msg + (extra ? ' ' + extra : '')).slice(0, 600) });
  }
  return out;
}

/** network 记录形如 {"type":"HTTP_REQUEST|HTTP_RESPONSE","detail":{...}} */
function parseNetwork(lines) {
  const out = [];
  for (const l of lines) {
    const j = tryJson(l);
    if (!j || !j.type) continue;
    const d = j.detail || {};
    out.push({
      type: j.type,
      method: d.method || '',
      url: String(d.url || ''),
      status: Number(d.status ?? -1),
      duration: String(d.duration || ''),
      response: String(d.response || '').slice(0, 200),
      code: (() => {
        const r = tryJson(String(d.response || ''));
        return r && (r.error || r.code) ? String(r.error || r.code) : '';
      })(),
      desc: (() => {
        const r = tryJson(String(d.response || ''));
        return r && r.error_description ? String(r.error_description) : '';
      })(),
    });
  }
  return out;
}

const uniq = (arr) => [...new Set(arr)];
const shorten = (s, n = 180) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

export function auditRuntime(project, bin, log = () => {}, opts = {}) {
  const call = opts.call || wechatide;
  const now = opts.now || Date.now;
  const pause = opts.pause || sleep;
  const deadline = now() + 90000;
  const issues = [];
  const raw = { console: [], network: [] };
  const stats = { consoleLines: 0, errors: 0, warns: 0, requests: 0, failures: 0 };

  try {
    const r = call('simulator_refresh', ['--project', project], { bin, timeout: 20000 });
    if (r?.ok === false || r?.result?.success === false) throw Error(r.message || '刷新未成功');
  } catch (e) {
    throw Error('运行日志采集前刷新失败，停止采集：' + shorten(e.message, 100));
  }

  // refresh 会重启小程序，必须等它重新编译完再往下走。
  // 不等就直接预热的话，那次调用会撞在重编译窗口上失败，整块运行时体检被判成
  // 「通道不可用」—— 真正的报错一条都读不到，用户拿到的是个假结论。
  // 这里 refresh:false —— 上面刚 refresh 过，再刷一次会把要读的缓冲区清空。
  const remaining = deadline - now();
  if (remaining <= 0 || !ensureReady(project, bin, { log, timeout: remaining / 1000, refresh: false, call, now, pause })) {
    throw Error('运行日志采集前模拟器未就绪，停止采集');
  }
  // ensureReady的成功探测已建立连接，不再重复预热或刷新。

  const readBuf = (tool) => {
    try {
      const r = call(tool, ['--project', project, '--command', 'grep -n .'], { bin });
      return typeof r.result === 'string' ? r.result : '';
    } catch {
      return '';
    }
  };

  // 缓冲区是懒刷新的：重编译 + 启动 + 首屏请求有先后，单次读容易读早。
  // 分几轮读，取最后一轮（缓冲区是累积的），拿到 error 与网络记录就提前收工。
  let consoleRecs = [];
  let netRecs = [];
  for (let i = 0; i < 3; i++) {
    pause(i === 0 ? 4 : 3);
    const c = parseConsole(parseRecords(readBuf('get_simulator_console')));
    const n = parseNetwork(parseRecords(readBuf('get_simulator_network')));
    if (c.length) consoleRecs = c;
    if (n.length) netRecs = n;
    if (consoleRecs.some((r) => /^(error|uncaught|fatal|assert)$/.test(r.level)) && netRecs.length) break;
  }
  const dedupe = (arr, key) => [...new Map(arr.map((x) => [key(x), x])).values()];
  consoleRecs = dedupe(consoleRecs, (r) => r.level + '|' + r.msg.slice(0, 200));
  netRecs = dedupe(netRecs, (r) => r.type + '|' + r.method + '|' + r.url + '|' + r.status);
  raw.console = consoleRecs;
  raw.network = netRecs;
  stats.consoleLines = consoleRecs.length;
  stats.requests = netRecs.filter((n) => n.type === 'HTTP_REQUEST').length;

  // ── console ──
  const errs = consoleRecs.filter((r) => /^(error|uncaught|fatal|assert)$/.test(r.level));
  const warns = consoleRecs.filter((r) => /^(warn|warning)$/.test(r.level));
  stats.errors = errs.length;
  stats.warns = warns.length;

  const groupByMsg = (list) => {
    const m = new Map();
    for (const r of list) {
      const key = r.msg.slice(0, 120);
      m.set(key, (m.get(key) || 0) + 1);
    }
    return [...m.entries()];
  };

  if (errs.length) {
    const groups = groupByMsg(errs);
    issues.push({
      level: 'P0',
      rule: '运行时报错',
      where: '小程序 console',
      msg:
        `${errs.length} 条 error（${groups.length} 类）：\n` +
        groups.slice(0, 5).map(([k, n]) => (n > 1 ? `×${n} ` : '') + shorten(k)).join('\n'),
      fix: '按消息定位到代码；修法取决于业务语义，需确认后再改',
    });
  }
  if (warns.length) {
    const groups = groupByMsg(warns);
    issues.push({
      level: 'P1',
      rule: '运行时告警',
      where: '小程序 console',
      msg:
        `${warns.length} 条 warn（${groups.length} 类）：\n` +
        groups.slice(0, 5).map(([k, n]) => (n > 1 ? `×${n} ` : '') + shorten(k)).join('\n'),
      fix: '多为废弃 API 或数据边界问题，按需处理',
    });
  }

  // ── network ──
  const responses = netRecs.filter((n) => n.type !== 'HTTP_REQUEST');
  const failed = responses.filter((n) => n.status === 0);
  const httpErr = responses.filter((n) => n.status >= 400);
  stats.failures = failed.length + httpErr.length;

  if (failed.length) {
    issues.push({
      level: 'P0',
      rule: '请求失败',
      where: '网络面板',
      msg:
        `${failed.length} 个请求未拿到响应：\n` +
        uniq(failed.map((n) => n.method + ' ' + n.url)).slice(0, 5).map((x) => shorten(x)).join('\n'),
      fix: '检查域名是否已在平台配置（开发期可临时关 urlCheck）、接口是否可达',
    });
  }
  if (httpErr.length) {
    issues.push({
      level: 'P1',
      rule: '接口异常响应',
      where: '网络面板',
      msg:
        `${httpErr.length} 个 4xx/5xx 响应：\n` +
        uniq(httpErr.map((n) => `HTTP ${n.status} ${n.method} ${n.url}` + (n.code ? ` [${n.code}]` : '') + (n.desc ? ` ${n.desc}` : '')))
          .slice(0, 5)
          .map((x) => shorten(x))
          .join('\n'),
      fix: '确认接口鉴权、参数与平台配置；若为预期的业务错误码可忽略',
    });
  }

  return { issues, raw, stats };
}
