/**
 * wechatide CLI 调用封装（微信开发者工具官方内部通道）。
 * 不依赖服务端口，不需要用户手动打开任何开关。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync, execFile } from 'child_process';

export const WECHATIDE = process.env.WECHATIDE_BIN || 'wechatide';
export const CLIENT = process.env.WECHATIDE_CLIENT || 'miniprogram-autocheck';
export const SKILL_VERSION = process.env.WECHATIDE_SKILL_VERSION || '0.3.11';

/** Windows 批处理必须通过解释器；参数整体编码，避免路径空格、中文和 shell 插值。 */
function cliCommand(bin, args) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return { bin, args };
  const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; & " +
    [bin, ...args].map(quote).join(' ') + '; exit $LASTEXITCODE';
  return { bin: 'powershell.exe', args: ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
}

/** 常见安装位置（用于 CLI 不在 PATH 时兜底） */
const CLI_CANDIDATES = [
  '/usr/local/bin/wechatide',
  '/opt/homebrew/bin/wechatide',
  '/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide',
  path.join(process.env.HOME || '', '.local/bin/wechatide'),
];

const SKILL_DIR_CANDIDATES = [
  '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/wechatide-skill',
];

/** 官方 installer 脚本所在目录（开发者工具自带），找不到返回 null */
export function findInstallerScripts() {
  for (const base of SKILL_DIR_CANDIDATES) {
    const dir = path.join(base, 'skills', 'installer', 'scripts');
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/** 定位可用的 wechatide 可执行文件，找不到返回 null */
export function findCli() {
  const command = cliCommand(WECHATIDE, ['--help']);
  const probe = spawnSync(command.bin, command.args, { stdio: 'ignore', timeout: 20000, killSignal: 'SIGKILL' });
  if (probe.status === 0) return WECHATIDE;
  for (const c of CLI_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * 从混合输出里取出第一个完整的 JSON 对象。
 * wechatide 的 stdout 前面有 `[wechatide] skill-call:` 日志，失败时 stderr 又会被拼在后面，
 * 都带括号，所以必须做括号配平扫描，不能简单 slice 到结尾。
 */
function extractJson(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

let tmpSeq = 0;

/**
 * 调用一个 wechatide 工具，返回解析后的 JSON。
 * bin 可传入 findCli() 的结果；未传则用默认命令。
 *
 * ★ 为什么不用 execFileSync（踩过坑，别改回去）：
 *   execFileSync 把 stdout/stderr 接在**管道**上。超时后它只 kill 掉直接子进程；
 *   如果 wechatide 自己还派生了子进程（孙进程）并持有那根管道，管道就永远不关闭，
 *   execFileSync 会**一直等下去**——实测表现是「timeout 设了 60s，却挂了好几分钟不返回，
 *   只能把整个 node 进程杀掉」，而且被强杀之后 automator 连接会留在坏状态。
 *   改成让子进程**直接把输出写进临时文件**：没有管道可等，超时后 SIGKILL 必定能返回。
 */
export function wechatide(tool, args = [], opts = {}) {
  const bin = opts.bin || WECHATIDE;
  const timeout = opts.timeout || 180000;
  const outFile = path.join(os.tmpdir(), 'wechatide-' + process.pid + '-' + ++tmpSeq + '.out');

  let fd = -1;
  let out = '';
  let timedOut = false;
  try {
    fd = fs.openSync(outFile, 'w');
    const command = cliCommand(bin, ['-c', CLIENT, tool, ...args]);
    const r = spawnSync(command.bin, command.args, {
      stdio: ['ignore', fd, fd],
      timeout,
      killSignal: 'SIGKILL',
    });
    try {
      fs.closeSync(fd);
    } catch {
      /* 已关闭 */
    }
    fd = -1;
    out = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
    timedOut = r && r.signal === 'SIGKILL';
    if (!out && r && r.error) throw new Error(tool + ' 调用失败: ' + r.error.message);
    if (!out && timedOut) throw new Error(tool + ' 超过 ' + Math.round(timeout / 1000) + ' 秒无响应，已终止');
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略 */
      }
    }
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* 忽略 */
    }
  }

  if (!out) throw new Error(tool + ' 无输出');
  const json = extractJson(out);
  if (!json) throw new Error(tool + ' 未返回 JSON: ' + out.slice(0, 200));
  return JSON.parse(json);
}

/** 查环境：CLI 是否可用、开发者工具是否登录 */
export function envStatus() {
  const bin = findCli();
  const st = {
    cli: !!bin,
    bin: bin || null,
    login: false,
    user: null,
    loginExpired: null,
    installerScripts: findInstallerScripts(),
    error: null,
  };
  if (!bin) return st;
  try {
    const r = wechatide('check_wechatide_status', ['--skill-version', SKILL_VERSION], { bin });
    const res = r.result || r; // 状态字段在 result 内
    st.loginExpired = res.loginExpired ?? null;
    const u = res.loginUser;
    st.user = (u && (u.nickName || u.nickname)) || (typeof u === 'string' ? u : null);
    st.login = res.loginExpired === false;
  } catch (e) {
    st.error = e.message;
  }
  return st;
}

/**
 * 打开项目窗口（幂等：同一工程已开则复用）。
 *
 * 注意：对**未打开的另一个工程**，这不是切走当前窗口，而是**再开一个模拟器窗口**——
 * 实测会同时出现两个模拟器。这是工具本身的行为，属预期；但「要不要操作另一个工程」
 * 必须由用户决定（见 SKILL.md「作用域」一节），不要自作主张换工程跑。
 */
export function openWindow(project, bin) {
  return wechatide('open_project_window', ['--project', project, '--window-mode', 'liteMode'], { bin });
}

export function sleep(sec) {
  const ms = Math.max(0, Number(sec) || 0) * 1000;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 异步等待（不要用同步版 sleep 配 wechatideAsync：同步 sleep 会卡住事件循环，令兜底定时器失效） */
export function sleepAsync(sec) {
  const ms = Math.max(0, Number(sec) || 0) * 1000;
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 异步版调用，**真正可控的超时**。
 *
 * 为什么必须有它：同步的 spawnSync/execFileSync 一旦遇到「子进程无响应、又派生孙进程持有输出管道」
 * 的情况，超时形同虚设——实测 timeout 设 60 秒，却挂了 5 分钟直到把整个 node 进程杀掉，
 * 期间什么错误都拿不到。异步版把兜底计时器放在事件循环里（不被阻塞），超时后
 * `process.kill(-pid)` **杀整个进程组**（连孙进程一起），因此一定能返回并抛出可读的错误。
 *
 * 适合用在「外部工具可能无响应」的高风险调用上（automation_*）。
 */
export function wechatideAsync(tool, args = [], opts = {}) {
  const bin = opts.bin || WECHATIDE;
  const timeout = opts.timeout || 60000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      fn(v);
    };

    const command = cliCommand(bin, ['-c', CLIENT, tool, ...args]);
    const child = execFile(
      command.bin,
      command.args,
      { maxBuffer: 64 * 1024 * 1024, detached: true },
      (err, stdout, stderr) => {
        const out = (stdout || '') + (stderr || '');
        if (err && !out) return done(reject, new Error(tool + ' 调用失败: ' + err.message));
        if (!out) return done(reject, new Error(tool + ' 无输出'));
        const json = extractJson(out);
        if (!json) return done(reject, new Error(tool + ' 未返回 JSON: ' + out.slice(0, 200)));
        try {
          done(resolve, JSON.parse(json));
        } catch (e) {
          done(reject, e);
        }
      }
    );

    // 兜底：execFile 自带的 timeout 也可能被孙进程的管道拖住，这里自己再来一刀
    const guard = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经退出 */
        }
      }
      done(reject, new Error(tool + ' 超过 ' + Math.round(timeout / 1000) + ' 秒无响应（已强制终止）'));
    }, timeout + 2000);
    guard.unref?.();
  });
}

/**
 * 等模拟器就绪：先 refresh，再轮询 evaluate 直到能拿到响应。
 *
 * 为什么必须有这一步：工程首次打开（或开发者工具刚重启）时，模拟器还在编译，
 * 此时任何 automator 调用都会 `timeout waiting for automator response`，
 * 采集结果会是空数组而不是报错——静默失败比报错更危险。
 *
 * @returns {boolean} 是否就绪
 */
export function ensureReady(project, bin, opts = {}) {
  const { timeout = 90, log = () => {}, refresh = true } = opts;

  // refresh:false 用于「调用方刚刚已经 refresh 过」的场景——
  // 再 refresh 一次会把调用方正要读取的 console / network 缓冲区清掉。
  if (refresh) {
    try {
      wechatide('simulator_refresh', ['--project', project], { bin, timeout: 240000 });
    } catch (e) {
      log('  simulator_refresh 未成功: ' + String(e.message).slice(0, 100));
    }
  }

  const deadline = Date.now() + timeout * 1000;
  let n = 0;
  while (Date.now() < deadline) {
    n++;
    try {
      const r = wechatide(
        'automation_evaluate',
        ['--project', project, '--fn-source', 'function(){return 1;}'],
        { bin, timeout: 45000 }
      );
      if (r && r.ok !== false && r.result && r.result.success !== false) {
        log('  模拟器就绪（第 ' + n + ' 次探测）');
        return true;
      }
    } catch {
      /* 未就绪，继续等 */
    }
    if (Date.now() >= deadline) break;
    sleep(3);
  }
  log('  模拟器 ' + timeout + ' 秒内未就绪（已探测 ' + n + ' 次）');
  return false;
}
