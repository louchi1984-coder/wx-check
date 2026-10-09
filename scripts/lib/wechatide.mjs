/**
 * wechatide CLI 调用封装（微信开发者工具官方内部通道）。
 * 不依赖服务端口，不需要用户手动打开任何开关。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

export const WECHATIDE = process.env.WECHATIDE_BIN || 'wechatide';
export const CLIENT = process.env.WECHATIDE_CLIENT || 'miniprogram-autocheck';

/** Windows 批处理必须通过解释器；参数整体编码，避免路径空格、中文和 shell 插值。 */
function cliCommand(bin, args) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return { bin, args };
  const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; & " +
    [bin, ...args].map(quote).join(' ') + '; exit $LASTEXITCODE';
  return { bin: 'powershell.exe', args: ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
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
 * bin 使用实际发现的CLI路径；未传则用默认命令。
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
    if (timedOut || r?.error?.code === 'ETIMEDOUT') throw new Error(tool + ' 超过 ' + Math.round(timeout / 1000) + ' 秒无响应，已终止');
    if (!out && r && r.error) throw new Error(tool + ' 调用失败: ' + r.error.message);
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
