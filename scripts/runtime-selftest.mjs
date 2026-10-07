#!/usr/bin/env node
import assert from 'node:assert/strict';
import { envStatus, loginProblem, loginLabel, ensureReady } from './lib/wechatide.mjs';
import { assertAutomationPage } from './lib/page-context.mjs';
import { tapElement } from './lib/tap-audit.mjs';
import { fillUnique } from './lib/ux-audit.mjs';
import { auditRuntime } from './lib/runtime-audit.mjs';
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('通过：' + name); };
const env = call => envStatus({ bin: '/fixture', call });
test('连接失败保持登录未知，不引导再次扫码', () => {
  const r = env(() => { throw Error('CONNECT_ERROR'); });
  assert.equal(r.loginExpired, null); assert.equal(loginLabel(r), '未确认');
  assert.match(loginProblem(r), /CONNECT_ERROR/); assert.doesNotMatch(loginProblem(r), /需扫码/);
});
test('接口返回失败保持登录未知', () => {
  const r = env(() => ({ ok: false, message: 'pending authorization' }));
  assert.match(r.error, /pending/); assert.doesNotMatch(loginProblem(r), /需扫码/);
});
test('明确过期才要求扫码', () => {
  const r = env(() => ({ result: { loginExpired: true } }));
  assert.equal(loginLabel(r), '已过期'); assert.match(loginProblem(r), /需扫码/);
});
test('明确已登录才放行', () => {
  assert.equal(env(() => ({ result: { loginExpired: false } })).login, true);
  assert.equal(env(() => ({ result: {} })).login, false);
});
test('状态查询使用20秒时限', () => {
  env((tool, args, opts) => { assert.equal(opts.timeout, 20000); return { result: { loginExpired: false } }; });
});
function ready(run, options = {}) {
  let time = 0; const calls = [];
  const result = ensureReady('/fixture', '/fixture', { timeout: 10, log: () => {},
    now: () => time, pause: s => { time += s * 1000; },
    call: (tool, args, opts) => { calls.push({ tool, timeout: opts.timeout }); return run(tool, opts, ms => { time += ms; }); }, ...options });
  return { result, time, calls };
}
const yes = { ok: true, result: { success: true, result: { result: 1 } } };
test('已经就绪不刷新', () => {
  const r = ready(() => yes); assert.equal(r.result, true); assert.equal(r.calls.length, 1);
});
test('未就绪最多刷新一次再探测', () => {
  let first = true;
  const r = ready(tool => {
    if (tool === 'simulator_refresh') return { ok: true };
    if (first) { first = false; return { ok: false }; } return yes;
  });
  assert.equal(r.result, true); assert.equal(r.calls.filter(x => x.tool === 'simulator_refresh').length, 1);
});
test('刷新失败立即停止', () => {
  const r = ready(() => ({ ok: false })); assert.equal(r.result, false); assert.equal(r.calls.length, 2);
});
test('探测和刷新共用预算，没有额外四分钟', () => {
  const r = ready((tool, opts, advance) => { advance(tool === 'simulator_refresh' ? opts.timeout : 6000); return { ok: false }; });
  assert.equal(r.result, false); assert.equal(r.time, 10000); assert.equal(r.calls[1].timeout, 4000);
});
test('持续忙到截止就停止，休眠不越过总时限', () => {
  const r = ready((tool, opts, advance) => { advance(Math.min(1000, opts.timeout)); return tool === 'simulator_refresh' ? { ok: true } : { ok: false }; });
  assert.equal(r.result, false); assert(r.time <= 10000); assert.equal(r.calls.filter(x => x.tool === 'simulator_refresh').length, 1);
});
test('禁用刷新时不刷新', () => {
  const r = ready(() => ({ ok: false }), { refresh: false });
  assert.equal(r.result, false); assert(r.calls.every(x => x.tool !== 'simulator_refresh'));
});
test('空成功响应不能冒充就绪', () => assert.equal(ready(() => ({ ok: true, result: { success: true } }), { refresh: false }).result, false));
test('运行日志刷新失败停止，不编造应用错误', () => {
  let calls = 0;
  assert.throws(() => auditRuntime('/fixture', null, () => {}, { call: (tool, args, opts) => { calls++; assert.equal(opts.timeout, 20000); return { ok: false }; } }), /刷新失败/);
  assert.equal(calls, 1);
});
test('运行日志准备的刷新与探测共用90秒预算', () => {
  let time = 0, reads = 0;
  assert.throws(() => auditRuntime('/fixture', null, () => {}, {
    now: () => time, pause: s => { time += s * 1000; }, call: (tool, args, opts) => {
      if (tool === 'simulator_refresh') { time += 20000; return { ok: true }; }
      if (tool === 'automation_evaluate') { time += opts.timeout; return { ok: false }; }
      reads++; return {};
    }
  }), /未就绪/);
  assert.equal(time, 90000); assert.equal(reads, 0);
});
test('运行日志准备成功不重复预热', () => {
  let probes = 0, refreshes = 0;
  const r = auditRuntime('/fixture', null, () => {}, { pause: () => {}, call: tool => {
    if (tool === 'simulator_refresh') { refreshes++; return { ok: true }; }
    if (tool === 'automation_evaluate') { probes++; return yes; }
    return { result: '' };
  } });
  assert.equal(probes, 1); assert.equal(refreshes, 1); assert.equal(r.stats.errors, 0);
});
function pageCall({ nativeId = 7, pageId = 7, route = 'home', path = 'home', missing = false, denied = false } = {}) {
  const mutations = [];
  const call = (tool, args) => {
    if (tool === 'automation_evaluate') return denied ? { ok: false } : { ok: true, result: { success: true, result: { result: { nativeId, route } } } };
    if (tool === 'automation_runtime_info') return { ok: true, result: { success: true, currentPage: missing ? {} : { pageId, path } } };
    if (tool === 'automation_page_action') return { result: { elements: [{}] } };
    mutations.push({ tool, args }); return { ok: true, result: { success: true } };
  };
  return { call, mutations };
}
test('编号及路径一致才允许点击', () => {
  const m = pageCall(); const r = tapElement('/fixture', null, '.button', m.call);
  assert.equal(r.ok, true); assert.equal(r.context.nativeId, 7); assert.equal(m.mutations.length, 1);
});
test('页面编号不一致零点击且要求停止', () => {
  const m = pageCall({ pageId: 8 }); const r = tapElement('/fixture', null, '.button', m.call);
  assert.equal(r.aborted, true); assert.equal(m.mutations.length, 0);
});
test('同路径旧实例也不能输入', () => {
  const m = pageCall({ pageId: 8 }); assert.throws(() => fillUnique('/fixture', null, '.input', 'text', m.call), /已过期/);
  assert.equal(m.mutations.length, 0);
});
test('编号缺失停止，不降为路径比较', () => {
  const m = pageCall({ missing: true }); assert.throws(() => assertAutomationPage('/fixture', null, m.call), /核对/);
});
test('编号一致但路径不同也停止', () => {
  const m = pageCall({ path: 'other' }); assert.throws(() => assertAutomationPage('/fixture', null, m.call), /路径不一致/);
});
test('运行页面查询失败不执行输入', () => {
  const m = pageCall({ denied: true }); assert.throws(() => fillUnique('/fixture', null, '.input', 'text', m.call), /读取失败/);
  assert.equal(m.mutations.length, 0);
});
test('已核对页面可以实际输入', () => {
  const m = pageCall(); assert.equal(fillUnique('/fixture', null, '.input', 'text', m.call).ok, true);
  assert.equal(m.mutations.length, 1); assert(m.mutations[0].args.includes('input'));
});
console.log(passed + ' 项运行状态与页面保护回归通过');
