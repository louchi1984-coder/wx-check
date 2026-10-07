#!/usr/bin/env node
/**
 * 证据保存与入口参数回归 —— 不调用开发者工具：所有用例都在环境检查之前退出。
 *   node scripts/evidence-selftest.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isOutside, resolveOutDir, saveReport } from './lib/evidence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('✓ ' + name); }
  catch (e) { process.exitCode = 1; console.log('✗ ' + name + '\n  ' + e.message); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-check-evidence-'));
const project = path.join(root, 'app');
const out = path.join(root, 'evidence');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'app.json'), '{"pages":[]}');
const run = (script, args) => spawnSync(process.execPath, [path.join(here, script), ...args], { encoding: 'utf8', timeout: 20000 });

try {
  t('isOutside：工程本身和子目录都不算工程外', () => {
    assert.equal(isOutside(project, project), false);
    assert.equal(isOutside(project, path.join(project, '.mp-autocheck')), false);
    assert.equal(isOutside(project, out), true);
    assert.equal(isOutside(project, path.join(root, 'app-evidence')), true);
  });

  t('resolveOutDir：缺失或位于工程内时拒绝', () => {
    assert.ok(resolveOutDir(project, undefined).error);
    assert.ok(resolveOutDir(project, path.join(project, 'out')).error);
    assert.equal(resolveOutDir(project, out).dir, out);
  });

  t('saveReport：同一时刻重复保存不覆盖，工程内只留最近副本', () => {
    const at = new Date('2026-10-07T00:00:00Z');
    const a = saveReport(project, out, 'report', { n: 1 }, at);
    const b = saveReport(project, out, 'report', { n: 2 }, at);
    assert.notEqual(a, b);
    assert.equal(JSON.parse(fs.readFileSync(a, 'utf8')).n, 1);
    assert.equal(JSON.parse(fs.readFileSync(b, 'utf8')).n, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.mp-autocheck', 'report.json'), 'utf8')).n, 2);
  });

  for (const script of ['selfcheck.mjs', 'tap-check.mjs', 'ux-check.mjs']) {
    t(script + '：缺少 --out 时退出码 2，不进入环境检查', () => {
      const r = run(script, ['--project', project]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /--out/);
      assert.doesNotMatch(r.stdout, /检查环境/);
    });
    t(script + '：--out 在工程内时拒绝', () => {
      const r = run(script, ['--project', project, '--out', path.join(project, 'evidence')]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /工程目录之外/);
    });
  }

  t('selfcheck：--tap / --only tap 报错并指向 tap-check', () => {
    for (const args of [['--tap'], ['--only', 'tap']]) {
      const r = run('selfcheck.mjs', ['--project', project, '--out', out, ...args]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /tap-check\.mjs/);
    }
  });

  t('selfcheck：未知 --only 模块报错', () => {
    const r = run('selfcheck.mjs', ['--project', project, '--out', out, '--only', 'nav']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /只接受/);
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(pass + ' 项证据与参数回归通过' + (process.exitCode ? '，存在失败项' : ''));
