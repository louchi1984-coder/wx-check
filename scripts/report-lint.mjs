#!/usr/bin/env node
/**
 * 交付报告校验：把 references/reporting.md 里能机器判定的规则变成脚本。
 *
 *   node scripts/report-lint.mjs --report <报告.md> [--base-dir <证据相对路径的基准目录>] [--no-links] [--json]
 *
 * 校验对象是给用户的 Markdown 报告（不是脚本原始 JSON）。只查结构、词表、数量一致和证据可访问，
 * 不判断内容对不对：通过校验不代表检测结论正确，只代表没有违反报告规范。
 * 退出码：0 无错误（可有警告）/ 1 有错误，须先补报告 / 2 用法错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DONE = ['已完成', '部分完成', '未执行', '不适用'];
export const RESULT = ['未发现问题', '发现问题', '待确认', '无法判断', '不适用'];
export const SUGGEST = ['需要修复', '建议优化', '暂不处理', '待确认'];
export const STATE = ['未修复', '已改待复测', '复测通过', '复测失败', '待确认'];

const SECTIONS = ['先看结论', '1. 本轮信息', '2. 结果总览', '3. 覆盖与证据', '4. 问题与修复建议', '5. 未覆盖与阻塞', '6. 修复与重测', '7. 下一步'];
const INFO_LABELS = ['工程', '检测时间', '代码版本', '环境', '本轮范围', '阶段'];
const PROJECTS = [
  { id: 'code', label: '1代码', row: /代码/, sub: /代码测试/, need: ['构建', '调试器', '问题面板', '输出', '调试控制台', '代码质量', '终端'] },
  { id: 'click', label: '3点击', row: /点击/, sub: /点击测试/, need: ['机型', '预期', '实际'] },
  { id: 'flow', label: '4流程', row: /流程/, sub: /流程测试/, need: ['任务', '识别缺口', '分支', '预期', '实际'] },
  { id: 'ui', label: '2UI', row: /UI/i, sub: /UI测试/i, need: ['机型', '分辨率', '读图'], image: true },
];

const JARGON = /模块\s*[A-H](?![A-Za-z])|automator|wechatide|selfcheck|Promise|(?<![A-Za-z])P[0-2](?![0-9])/i;
const BANNED = /走查|复验|闭环|第[一二三四]层/;
const TIME = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}:\d{2}/;
const EVIDENCE_REF = /\]\([^)\s]+\)|`[^`]*[\/\\][^`]*`|`[^`]+\.(?:json|png|jpe?g|webp|md|log|txt)`/i;
const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const clean = (s) => String(s ?? '').replace(/[*`~]/g, '').replace(/\s+/g, ' ').trim();
const isBlankCell = (s) => ['', '无', '-', '—', '–'].includes(clean(s));

/** 把围栏代码块内容清空（保留行号），其中的文字不参与校验。 */
function maskCode(md) {
  let inCode = false;
  return md.split('\n').map((l) => {
    if (/^\s*(```|~~~)/.test(l)) { inCode = !inCode; return ''; }
    return inCode ? '' : l;
  });
}

function splitRow(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

function parseTables(entries) {
  const tables = [];
  let i = 0;
  while (i < entries.length) {
    const t = entries[i].text;
    const next = entries[i + 1]?.text ?? '';
    if (/^\s*\|/.test(t) && next.includes('|') && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(next)) {
      const header = splitRow(t);
      const rows = [];
      let j = i + 2;
      while (j < entries.length && /^\s*\|/.test(entries[j].text)) {
        const cells = splitRow(entries[j].text);
        if (!cells.every(isBlankCell)) rows.push({ cells, line: entries[j].line });
        j++;
      }
      tables.push({ header, rows, line: entries[i].line });
      i = j;
    } else i++;
  }
  return tables;
}

const colIndex = (table, name) => table.header.findIndex((h) => clean(h).includes(name));
const prose = (entries) => entries.filter((e) => e.text.trim() && !/^\s*[|#]/.test(e.text));
const joined = (entries) => entries.map((e) => e.text).join('\n');
const parseCount = (s) => {
  const c = clean(s);
  if (/^\d+$/.test(c)) return Number(c);
  return c === '未统计' ? 'unknown' : null;
};
const projectOf = (cell) => PROJECTS.find((p) => p.row.test(clean(cell)));

export function lintReport(markdown, opts = {}) {
  const { baseDir = process.cwd(), fileExists = fs.existsSync, checkLinks = true } = opts;
  const errors = [];
  const warnings = [];
  const err = (rule, msg, line = null) => errors.push({ rule, msg, line });
  const warn = (rule, msg, line = null) => warnings.push({ rule, msg, line });

  const lines = maskCode(String(markdown).replace(/\r\n?/g, '\n'));
  const entries = lines.map((text, i) => ({ text, line: i + 1 }));

  // ── 标题与固定 7 节 ─────────────────────────────────────────
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx < 0 || lines[firstIdx].trim() !== '# 小程序检测报告') {
    err('title', '第一行必须是“# 小程序检测报告”', firstIdx < 0 ? null : firstIdx + 1);
  }
  const h2 = [];
  lines.forEach((l, i) => { const m = /^##\s+(\S.*?)\s*$/.exec(l); if (m) h2.push({ title: m[1], idx: i }); });

  const sec = {};
  let last = -1;
  for (const name of SECTIONS) {
    const k = h2.findIndex((h) => h.title === name);
    if (k < 0) { err('section-missing', '缺少固定标题“## ' + name + '”（不得改名或删节）'); continue; }
    if (k < last) err('section-order', '“## ' + name + '”顺序错误，必须按模板顺序', h2[k].idx + 1);
    last = Math.max(last, k);
    const end = k + 1 < h2.length ? h2[k + 1].idx : lines.length;
    sec[name] = { heading: h2[k].idx + 1, entries: entries.slice(h2[k].idx + 1, end) };
  }
  for (const h of h2) if (!SECTIONS.includes(h.title)) warn('extra-section', '模板之外的标题“## ' + h.title + '”：规范要求不新增栏目', h.idx + 1);

  const firstH2 = h2.length ? h2[0].idx : lines.length;
  if (entries.slice(firstIdx + 1, firstH2).some((e) => /^\s*\|/.test(e.text))) {
    err('summary-first', '“先看结论”之前不能出现表格或明细');
  }
  if (h2.length && h2[0].title !== '先看结论') err('summary-first', '“先看结论”必须紧跟标题', h2[0].idx + 1);

  // ── 先看结论 ───────────────────────────────────────────────
  const sum = sec['先看结论'];
  if (sum) {
    const text = prose(sum.entries).map((e) => clean(e.text)).join('');
    if (!text) err('summary-empty', '“先看结论”没有内容', sum.heading);
    else {
      const n = text.split(/[。！？!?]+/).filter((s) => s.trim()).length;
      if (n < 3 || n > 5) warn('summary-length', '“先看结论”应为 3—5 句，现为 ' + n + ' 句', sum.heading);
      if (JARGON.test(text)) err('summary-jargon', '“先看结论”出现技术词（模块字母、P0/P1、automator、Promise 等），请改成用户能懂的话', sum.heading);
    }
  }

  // ── 1. 本轮信息 ─────────────────────────────────────────────
  const info = sec['1. 本轮信息'];
  if (info) {
    const text = joined(info.entries);
    for (const label of INFO_LABELS) {
      const m = new RegExp('^\\s*[-*]\\s*' + label + '\\s*[：:]\\s*(.*)$', 'm').exec(text);
      if (!m) { err('info-missing', '本轮信息缺少“' + label + '”', info.heading); continue; }
      if (!m[1].trim()) err('info-missing', '“' + label + '”没有内容，无法确认时写“未确认”', info.heading);
      if (label === '阶段' && !/检测后|修复后复测/.test(m[1])) err('stage', '“阶段”只能写“检测后”或“修复后复测”', info.heading);
    }
  }

  // ── 2. 结果总览 ─────────────────────────────────────────────
  const ovInfo = {};
  const ov = sec['2. 结果总览'];
  if (ov) {
    if (!prose(ov.entries).length) err('overview-summary', '总览表前要有一句普通话说明', ov.heading);
    const t = parseTables(ov.entries).find((x) => colIndex(x, '检测项目') >= 0);
    const ci = t && { status: colIndex(t, '完成状态'), result: colIndex(t, '检查结果'), prob: colIndex(t, '已确认问题数'), unc: colIndex(t, '未覆盖项数') };
    if (!t || Object.values(ci).some((v) => v < 0)) err('overview-columns', '总览表缺失或缺列（检测项目/完成状态/检查结果/已确认问题数/未覆盖项数）', ov.heading);
    else {
      if (t.rows.length !== 4) err('overview-row', '总览表必须有 4 行（代码、点击、流程、UI），现为 ' + t.rows.length + ' 行；未选项也保留并写“未执行”', t.line);
      PROJECTS.forEach((p, k) => {
        const row = t.rows[k];
        if (!row) return;
        if (!p.row.test(clean(row.cells[0]))) { err('overview-row', '总览第 ' + (k + 1) + ' 行应为“' + p.label + '”，顺序固定为 代码→点击→流程→UI', row.line); return; }
        const status = clean(row.cells[ci.status]);
        const result = clean(row.cells[ci.result]);
        const prob = parseCount(row.cells[ci.prob]);
        const unc = parseCount(row.cells[ci.unc]);
        const bad = (rule, msg) => err(rule, p.label + '：' + msg, row.line);
        if (!DONE.includes(status)) bad('overview-status', '完成状态“' + status + '”不在词表（' + DONE.join('、') + '）');
        if (!RESULT.includes(result)) bad('overview-result', '检查结果“' + result + '”不在词表（' + RESULT.join('、') + '）');
        if (prob === null) bad('overview-count', '已确认问题数必须是数字或“未统计”');
        if (unc === null) bad('overview-count', '未覆盖项数必须是数字或“未统计”');
        ovInfo[p.id] = { status: DONE.includes(status) ? status : null, result, prob, unc, line: row.line };
        if (status === '未执行') {
          if (result !== '无法判断') bad('overview-result', '未执行的检测项目，检查结果只能写“无法判断”');
          if (unc === 0) bad('overview-count', '未执行时未覆盖项数不能写 0（没有清单就写“未统计”）');
        } else if (status === '不适用') {
          if (result !== '不适用') bad('overview-result', '不适用的检测项目，检查结果写“不适用”');
        } else if (status === '已完成' || status === '部分完成') {
          if (prob === 'unknown' || unc === 'unknown') bad('overview-count', '已执行的检测项目不能写“未统计”');
          if (status === '已完成' && typeof unc === 'number' && unc > 0) bad('overview-consistency', '有 ' + unc + ' 个未覆盖项却标“已完成”，应为“部分完成”');
          if (status === '部分完成' && unc === 0) bad('overview-consistency', '标“部分完成”但未覆盖项数为 0，请写明缺口或改为“已完成”');
          if (result === '未发现问题' && typeof prob === 'number' && prob > 0) bad('overview-consistency', '已确认问题数为 ' + prob + '，检查结果不能是“未发现问题”');
          if (result === '发现问题' && prob === 0) bad('overview-consistency', '检查结果是“发现问题”，但已确认问题数为 0');
        }
      });
    }
  }

  // ── 3. 覆盖与证据 ───────────────────────────────────────────
  const cov = sec['3. 覆盖与证据'];
  if (cov) {
    const subs = [];
    cov.entries.forEach((e, i) => { const m = /^###\s+(\S.*?)\s*$/.exec(e.text); if (m) subs.push({ title: m[1], i, line: e.line }); });
    let lastPos = -1;
    PROJECTS.forEach((p) => {
      const pos = subs.findIndex((s) => p.sub.test(s.title));
      if (pos < 0) { err('coverage-section', '第 3 节缺少“' + p.label + '测试”小节（未选项写“本轮未选择”）', cov.heading); return; }
      if (pos < lastPos) err('coverage-section', '第 3 节小节顺序应为 代码→点击→流程→UI', subs[pos].line);
      lastPos = Math.max(lastPos, pos);
      const end = pos + 1 < subs.length ? subs[pos + 1].i : cov.entries.length;
      const body = cov.entries.slice(subs[pos].i + 1, end);
      const text = joined(body);
      const st = ovInfo[p.id]?.status;
      const bad = (rule, msg) => err(rule, p.label + '测试小节：' + msg, subs[pos].line);
      if (st === '未执行') {
        if (!/本轮未选择|本轮未检测/.test(text)) bad('coverage-unselected', '总览标“未执行”，小节应写“本轮未选择”');
        return;
      }
      if (st !== '已完成' && st !== '部分完成') return;
      const firstLine = body.find((e) => e.text.trim());
      if (!firstLine || /^\s*[|!]/.test(firstLine.text)) bad('coverage-summary', '小节开头要先写 1—2 句通俗结论，再放表格或图片');
      if (!TIME.test(text)) bad('coverage-time', '缺少证据时间');
      if (!EVIDENCE_REF.test(text) && !/!\[/.test(text)) bad('coverage-link', '缺少证据链接或路径');
      const missing = p.need.filter((kw) => !text.includes(kw));
      if (missing.length) bad('coverage-keywords', '缺少必填内容：' + missing.join('、') + '（无法检查的也要写“未覆盖／不适用”及原因）');
      if (p.image && !/!\[[^\]]*\]\([^)]+\)/.test(text) && !/未采集|截图缺口/.test(text)) bad('coverage-image', '精测截图要直接内嵌；没有图就明确写“未采集”及原因');
    });
  }

  // ── 4. 问题与修复建议 ───────────────────────────────────────
  const problems = new Map();
  const probSec = sec['4. 问题与修复建议'];
  let problemRows = 0;
  if (probSec) {
    const t = parseTables(probSec.entries).find((x) => colIndex(x, '问题编号') >= 0);
    if (!t) err('problem-table', '缺少问题表（无问题也保留表头并写“无”）', probSec.heading);
    else {
      const c = { id: colIndex(t, '问题编号'), owner: colIndex(t, '归属检测'), sug: colIndex(t, '处理建议'), state: colIndex(t, '当前状态'), ev: colIndex(t, '证据') };
      if (Object.values(c).some((v) => v < 0)) err('problem-table', '问题表缺列（问题编号/归属检测/处理建议/当前状态/证据）', t.line);
      else {
        for (const row of t.rows) {
          problemRows++;
          const id = clean(row.cells[c.id]);
          const sug = clean(row.cells[c.sug]);
          const state = clean(row.cells[c.state]);
          if (!id) err('problem-row', '问题编号为空', row.line);
          else if (problems.has(id)) err('problem-dup', '问题编号重复：' + id + '（一个根因一个稳定编号，跨机型／阶段只追加证据）', row.line);
          else problems.set(id, state);
          if (!SUGGEST.includes(sug)) err('problem-enum', id + '：处理建议“' + sug + '”不在词表（' + SUGGEST.join('、') + '）', row.line);
          if (!STATE.includes(state)) err('problem-enum', id + '：当前状态“' + state + '”不在词表（' + STATE.join('、') + '）', row.line);
          if (isBlankCell(row.cells[c.ev]) || clean(row.cells[c.ev]) === '未确认') err('problem-row', id + '：缺少证据', row.line);
          if (!projectOf(row.cells[c.owner]) && !/测试工具/.test(clean(row.cells[c.owner]))) warn('problem-owner', id + '：归属检测应是 代码／点击／流程／UI 或“测试工具问题”', row.line);
        }
      }
    }
    if (!problemRows && !/无|未发现/.test(joined(probSec.entries))) err('problem-table', '没有问题时要在问题表中写“无”', probSec.heading);
    const confirmed = Object.values(ovInfo).reduce((s, o) => s + (typeof o.prob === 'number' ? o.prob : 0), 0);
    if (confirmed > problemRows) err('problem-count', '总览已确认问题数合计 ' + confirmed + '，但问题表只有 ' + problemRows + ' 行', probSec.heading);
  }

  // ── 5. 未覆盖与阻塞 ─────────────────────────────────────────
  const uncSec = sec['5. 未覆盖与阻塞'];
  if (uncSec) {
    const t = parseTables(uncSec.entries).find((x) => colIndex(x, '原因') >= 0);
    const rows = t ? t.rows : [];
    const c = t && { item: 0, reason: colIndex(t, '原因'), need: colIndex(t, '补测需要') };
    const actual = { code: 0, click: 0, flow: 0, ui: 0 };
    let unattributed = 0;
    for (const row of rows) {
      if (isBlankCell(row.cells[c.reason])) err('uncovered-row', '未覆盖项缺少原因：' + clean(row.cells[0]), row.line);
      if (c.need >= 0 && isBlankCell(row.cells[c.need])) err('uncovered-row', '未覆盖项缺少“补测需要什么”：' + clean(row.cells[0]), row.line);
      const p = projectOf(row.cells[0]);
      if (p) actual[p.id]++; else unattributed++;
    }
    const expectedNums = Object.entries(ovInfo).filter(([, o]) => typeof o.unc === 'number');
    if (unattributed) {
      warn('uncovered-owner', unattributed + ' 行未覆盖项无法判断属于哪类检测（第一列请以 代码／点击／流程／UI 开头）', uncSec.heading);
      const total = expectedNums.reduce((s, [, o]) => s + o.unc, 0);
      if (total !== rows.length) err('uncovered-count', '总览未覆盖项数合计 ' + total + '，第 5 节明细 ' + rows.length + ' 行，数量不一致', uncSec.heading);
    } else {
      for (const [id, o] of expectedNums) {
        if (o.unc !== actual[id]) err('uncovered-count', PROJECTS.find((p) => p.id === id).label + '：总览未覆盖项数 ' + o.unc + '，第 5 节明细 ' + actual[id] + ' 行，数量不一致', o.line);
      }
    }
    if (!rows.length && !/无/.test(joined(uncSec.entries))) err('uncovered-row', '没有未覆盖项时要在第 5 节写“无”', uncSec.heading);
  }

  // ── 6. 修复与重测 ───────────────────────────────────────────
  const repSec = sec['6. 修复与重测'];
  if (repSec) {
    const t = parseTables(repSec.entries).find((x) => colIndex(x, '问题编号') >= 0 && colIndex(x, '复测结果') >= 0);
    const rows = t ? t.rows : [];
    if (!rows.length && !/本轮未执行修复/.test(joined(repSec.entries))) err('repair-none', '没有修复记录时要明确写“本轮未执行修复”', repSec.heading);
    const repaired = new Set();
    if (t) {
      const c = { id: colIndex(t, '问题编号'), result: colIndex(t, '复测结果'), ev: colIndex(t, '证据') };
      for (const row of rows) {
        const id = clean(row.cells[c.id]);
        repaired.add(id);
        if (!problems.has(id)) err('repair-ref', '修复记录引用了第 4 节不存在的问题编号：' + id, row.line);
        if (isBlankCell(row.cells[c.result])) err('repair-result', id + '：缺少复测结果', row.line);
        if (c.ev >= 0 && (isBlankCell(row.cells[c.ev]) || clean(row.cells[c.ev]) === '未确认')) err('repair-result', id + '：缺少复测证据', row.line);
        const st = problems.get(id);
        const passed = /通过/.test(clean(row.cells[c.result]).replace(/未通过|不通过/g, ''));
        if (st && passed && (st === '未修复' || st === '待确认')) {
          warn('repair-state', id + '：复测结果写了通过，第 4 节状态仍是“' + st + '”', row.line);
        }
      }
    }
    for (const [id, st] of problems) {
      if (['已改待复测', '复测通过', '复测失败'].includes(st) && !repaired.has(id)) {
        err('repair-state', id + '：状态是“' + st + '”，但第 6 节没有对应的修复与重测记录', repSec.heading);
      }
    }
  }

  // ── 7. 下一步 ───────────────────────────────────────────────
  const next = sec['7. 下一步'];
  if (next && !prose(next.entries).length && !next.entries.some((e) => /^\s*[-*\d]/.test(e.text))) err('next-empty', '第 7 节没有内容', next.heading);

  // ── 全文：占位符、禁用词 ────────────────────────────────────
  entries.forEach(({ text, line }) => {
    if (/<[^<>\n]*[一-鿿][^<>\n]*>/.test(text)) err('placeholder', '仍有模板占位符未替换：' + text.trim().slice(0, 40), line);
    if (/\b(?:TODO|TBD|XXX)\b|待填/.test(text)) err('placeholder', '仍有待填内容：' + text.trim().slice(0, 40), line);
    const b = BANNED.exec(text);
    if (b) err('banned-term', '面向用户不使用“' + b[0] + '”，请改成具体说法', line);
  });

  // ── 证据链接可访问 ──────────────────────────────────────────
  if (checkLinks) {
    entries.forEach(({ text, line }) => {
      for (const m of text.matchAll(LINK)) {
        const target = m[1];
        if (/^(https?:|mailto:|#|data:)/i.test(target)) continue;
        let p = target.replace(/^file:\/\//i, '').split('#')[0].split('?')[0];
        try { p = decodeURIComponent(p); } catch { /* 保留原样 */ }
        if (!p) continue;
        const abs = path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || /^file:/i.test(target);
        if (abs) warn('link-absolute', '证据使用了绝对路径（换机器后打不开）：' + target, line);
        if (!fileExists(abs ? p : path.resolve(baseDir, p))) err('link-missing', '证据文件不存在：' + target, line);
      }
    });
  }

  return { ok: errors.length === 0, errors, warnings };
}

function main(argv) {
  const arg = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
  const file = arg('report');
  if (!file || !fs.existsSync(file)) {
    console.error('用法: node report-lint.mjs --report <报告.md> [--base-dir <目录>] [--no-links] [--json]');
    return 2;
  }
  const result = lintReport(fs.readFileSync(file, 'utf8'), {
    baseDir: arg('base-dir') ? path.resolve(arg('base-dir')) : path.dirname(path.resolve(file)),
    checkLinks: !argv.includes('--no-links'),
  });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const at = (x) => (x.line ? '第' + x.line + '行 ' : '');
    for (const e of result.errors) console.log('✗ [' + e.rule + '] ' + at(e) + e.msg);
    for (const w of result.warnings) console.log('! [' + w.rule + '] ' + at(w) + w.msg);
    console.log(result.ok
      ? '报告格式校验通过（警告 ' + result.warnings.length + ' 条）。这只代表符合报告规范，不代表检测结论正确。'
      : '报告校验未通过：错误 ' + result.errors.length + ' 条，警告 ' + result.warnings.length + ' 条。请补齐后再交付。');
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
