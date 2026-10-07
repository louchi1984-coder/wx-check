#!/usr/bin/env node
/**
 * 诊断面板整理逻辑回归 —— 注入读取函数，不连接开发者工具。
 *   node scripts/diagnostics-selftest.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditDiagnostics, explainReadFailure, summarizeDiagnostics } from './lib/diagnostics-audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('✓ ' + name); }
  catch (e) { process.exitCode = 1; console.log('✗ ' + name + '\n  ' + e.message); }
};
const byId = (r, id) => r.panels.find((p) => p.id === id);

const goodRaw = (over = {}) => ({
  time: '2026-10-07T00:00:00Z',
  build: { ready: false, logs: ['compile ok', 'Error: something failed'] },
  quality: { result: [{ success: true, text: '主包' }, { success: false, text: '无使用文件', detail: 'a.js' }] },
  ...over,
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-check-diag-'));
const project = path.join(root, 'app');
const out = path.join(root, 'evidence');
fs.mkdirSync(project);
fs.mkdirSync(out);
fs.writeFileSync(path.join(project, 'app.json'), '{"pages":[]}');

try {
  t('读取失败：构建与代码质量都标未覆盖，不当作无问题', () => {
    const r = summarizeDiagnostics({ raw: null, readError: '端口未开' });
    assert.equal(byId(r, 'build').status, '未覆盖');
    assert.equal(byId(r, 'codeQuality').status, '未覆盖');
    assert.equal(r.issues.length, 0);
    assert.equal(r.stats.checked, 0);
  });

  t('始终列出 7 个面板；问题/输出/调试控制台/终端固定未覆盖', () => {
    const r = summarizeDiagnostics({ raw: goodRaw() });
    assert.equal(r.panels.length, 7);
    for (const id of ['problems', 'output', 'debugConsole', 'terminal']) assert.equal(byId(r, id).status, '未覆盖');
  });

  t('代码质量：success=false 的项变成 P1，通过项不报', () => {
    const r = summarizeDiagnostics({ raw: goodRaw() });
    assert.equal(byId(r, 'codeQuality').status, '已检查');
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].level, 'P1');
    assert.match(r.issues[0].msg, /无使用文件/);
  });

  t('代码质量：结果为空或缺 success 字段 → 未覆盖', () => {
    assert.equal(byId(summarizeDiagnostics({ raw: goodRaw({ quality: { result: [] } }) }), 'codeQuality').status, '未覆盖');
    assert.equal(byId(summarizeDiagnostics({ raw: goodRaw({ quality: { result: [{ text: 'x' }] } }) }), 'codeQuality').status, '未覆盖');
  });

  t('构建面板：面板已消费队列时不能当作已检查，空队列不等于无日志', () => {
    const r = summarizeDiagnostics({ raw: goodRaw({ build: { ready: true, logs: [] } }) });
    assert.equal(byId(r, 'build').status, '未覆盖');
    assert.match(byId(r, 'build').reason, /空队列/);
  });

  t('构建面板：未消费队列 → 已检查，错误关键字只作线索不进 issues', () => {
    const r = summarizeDiagnostics({ raw: goodRaw() });
    const b = byId(r, 'build');
    assert.equal(b.status, '已检查');
    assert.equal(b.evidence.queued, 2);
    assert.equal(b.evidence.errorLikeHints, 1);
    assert.ok(!r.issues.some((i) => i.rule !== 'code-quality'));
  });

  t('调试器：runtime 成功 → 部分覆盖；未执行或跳过 → 未覆盖', () => {
    const stats = { consoleLines: 3, errors: 0, warns: 1, requests: 2, failures: 0 };
    assert.equal(byId(summarizeDiagnostics({ raw: goodRaw(), runtime: { stats, issues: [] } }), 'debugger').status, '部分覆盖');
    assert.equal(byId(summarizeDiagnostics({ raw: goodRaw() }), 'debugger').status, '未覆盖');
    assert.equal(byId(summarizeDiagnostics({ raw: goodRaw(), runtime: { skipped: true, stats } }), 'debugger').status, '未覆盖');
  });

  t('explainReadFailure：连接被拒绝时说明需授权开启调试端口', () => {
    assert.match(explainReadFailure('TypeError: fetch failed', 9223), /9223.*授权/);
  });

  t('auditDiagnostics：读取脚本失败 → unavailable，不抛异常', () => {
    const r = auditDiagnostics(project, { outDir: out, run: () => ({ status: 1, stdout: '', stderr: 'TypeError: fetch failed' }) });
    assert.equal(r.unavailable, true);
    assert.equal(byId(r, 'codeQuality').status, '未覆盖');
  });

  t('auditDiagnostics：成功时读取注入脚本写出的证据文件', () => {
    const run = (args) => {
      fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify(goodRaw()));
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = auditDiagnostics(project, { outDir: out, run });
    assert.ok(!r.unavailable);
    assert.ok(r.rawFile && fs.existsSync(r.rawFile));
    assert.equal(r.stats.checked, 2);
  });

  t('auditDiagnostics：证据文件不是合法 JSON → unavailable', () => {
    const run = (args) => { fs.writeFileSync(args[args.indexOf('--out') + 1], '{bad'); return { status: 0, stdout: '', stderr: '' }; };
    assert.equal(auditDiagnostics(project, { outDir: out, run }).unavailable, true);
  });

  t('selfcheck --only diagnostics 通过参数校验（缺 --out 仍先报错）', () => {
    const r = spawnSync(process.execPath, [path.join(here, 'selfcheck.mjs'), '--project', project, '--only', 'diagnostics'], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--out/);
    assert.doesNotMatch(r.stderr, /只接受/);
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(pass + ' 项诊断面板回归通过' + (process.exitCode ? '，存在失败项' : ''));
