import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const READER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'read-ide-diagnostics.mjs');
const ERROR_LIKE = /error|fail|exception|错误|失败|异常/i;

/** 面板状态词表：已检查 / 部分覆盖 / 未覆盖 / 不适用（与 code-testing.md 一致） */
export const PANEL_STATUS = ['已检查', '部分覆盖', '未覆盖', '不适用'];

const panel = (id, name, status, reason, evidence) => ({ id, name, status, reason, ...(evidence ? { evidence } : {}) });
const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const clip = (s, n = 200) => String(s).slice(0, n);

/** 把 read-ide-diagnostics 原始结果整理成逐面板状态。纯函数，便于离线回归。 */
export function summarizeDiagnostics({ raw, readError, runtime, rawFile }) {
  const issues = [];
  const panels = [];

  if (!raw) {
    const why = '诊断读取失败：' + (readError || '未知原因');
    panels.push(
      panel('build', '构建面板', '未覆盖', why),
      panel('codeQuality', '代码质量', '未覆盖', why),
    );
  } else {
    // 构建面板：队列只含尚未被面板消费的消息
    const logs = Array.isArray(raw.build?.logs) ? raw.build.logs : null;
    if (!logs) {
      panels.push(panel('build', '构建面板', '未覆盖', '构建日志结构变化，未读到队列'));
    } else {
      const lines = logs.map(text);
      const hints = lines.filter((l) => ERROR_LIKE.test(l));
      const evidence = { queued: lines.length, errorLikeHints: hints.length, samples: hints.slice(0, 5).map((l) => clip(l)) };
      if (raw.build.ready) {
        panels.push(panel('build', '构建面板', '未覆盖',
          '面板已消费消息队列，队列内容不是全部历史，空队列不能解释为无日志；需继续读终端缓冲或截图', evidence));
      } else {
        panels.push(panel('build', '构建面板', '已检查',
          '读到面板尚未消费的当前窗口消息队列；“疑似错误线索”只是关键字匹配，需人工解释，不计为确定问题', evidence));
      }
    }

    // 代码质量
    const items = raw.quality?.result;
    if (!Array.isArray(items) || !items.length) {
      panels.push(panel('codeQuality', '代码质量', '未覆盖', '结果为空或结构变化，不能解释为无问题'));
    } else if (!items.every((i) => i && typeof i.success === 'boolean')) {
      panels.push(panel('codeQuality', '代码质量', '未覆盖', '结果缺少可判定的 success 字段，无法区分通过与未通过', { items: items.length }));
    } else {
      const failed = items.filter((i) => i.success === false);
      for (const i of failed) {
        issues.push({
          level: 'P1',
          rule: 'code-quality',
          where: '开发者工具·代码质量',
          msg: clip(text(i.text ?? i.name ?? '未命名检查项'), 120) + (i.detail ? ' — ' + clip(text(i.detail), 300) : ''),
        });
      }
      panels.push(panel('codeQuality', '代码质量', '已检查',
        '读取当前工程的编译分析结果（非历史界面扫描），采集时间 ' + (raw.time || '未知'),
        { items: items.length, failed: failed.length }));
    }
  }

  // 调试器（Console / Network）：CLI 采集不等于面板全部消息
  if (runtime && runtime.stats && !runtime.skipped) {
    panels.push(panel('debugger', '调试器', '部分覆盖',
      'runtime 模块经 CLI 采集 console/network；CLI 缓冲区不等于调试器面板全部消息，面板徽标数需另行核对',
      { consoleLines: runtime.stats.consoleLines, errors: runtime.stats.errors, warns: runtime.stats.warns, requests: runtime.stats.requests, failures: runtime.stats.failures }));
  } else {
    panels.push(panel('debugger', '调试器', '未覆盖', 'runtime 模块本轮未成功执行，调试器 Console/Network 没有证据'));
  }

  panels.push(
    panel('problems', '问题面板', '未覆盖', '脚本不读取；用窗口可访问性切换该面板读取，读不到再截图'),
    panel('output', '输出面板', '未覆盖', '脚本不读取；按“打开活动日志输出文件”定位原始日志，并核对与可见正文一致'),
    panel('debugConsole', '调试控制台', '未覆盖', '脚本不读取；无调试会话时由执行者确认后标“不适用”，不能默认视为通过'),
    panel('terminal', '相关终端', '未覆盖', '脚本不运行工程命令；由执行者核对本工程已有的构建、lint、类型检查、测试命令'),
  );

  const count = (s) => panels.filter((p) => p.status === s).length;
  return {
    panels,
    issues,
    rawFile: rawFile || null,
    stats: { panels: panels.length, checked: count('已检查'), partial: count('部分覆盖'), uncovered: count('未覆盖'), notApplicable: count('不适用') },
  };
}

/** 把 spawn 的失败输出压缩成一句人能看懂的原因。 */
export function explainReadFailure(stderr, port) {
  const s = String(stderr || '');
  if (/fetch failed|ECONNREFUSED|ConnectTimeout|UND_ERR/i.test(s)) {
    return '本机调试端口 ' + port + ' 未开启；需用户授权开启（首次需重启一次开发者工具），脚本不自行重启';
  }
  const line = s.split('\n').map((l) => l.trim()).filter((l) => /^(Error|TypeError|RangeError)?:?\s*\S/.test(l) && /Error:|无法|变化|拒绝|超时|用法|必须/.test(l)).pop();
  return clip(line || s.trim().split('\n').pop() || '读取脚本无输出', 300);
}

function defaultRun(args) {
  const r = spawnSync(process.execPath, [READER, ...args], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

/**
 * 读取开发者工具诊断证据并整理成逐面板状态。
 * run 可注入，离线回归不触碰开发者工具。
 */
export function auditDiagnostics(project, { outDir, port = 9223, runtime, run = defaultRun, now = new Date() } = {}) {
  const rawFile = path.join(outDir, 'diagnostics-raw-' + now.toISOString().replace(/[:.]/g, '-') + '.json');
  const r = run(['--project', project, '--out', rawFile, '--port', String(port)]);
  if (r.status !== 0 || !fs.existsSync(rawFile)) {
    const readError = explainReadFailure(r.stderr, port);
    return { unavailable: true, reason: readError, ...summarizeDiagnostics({ raw: null, readError, runtime }) };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
  } catch (e) {
    const readError = '诊断证据文件不是有效 JSON：' + e.message;
    return { unavailable: true, reason: readError, ...summarizeDiagnostics({ raw: null, readError, runtime, rawFile }) };
  }
  return summarizeDiagnostics({ raw, runtime, rawFile });
}
