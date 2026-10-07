import fs from 'node:fs';
import path from 'node:path';

/** 判断 dir 是否位于 project 之外（不含 project 本身）。 */
export function isOutside(project, dir) {
  const relative = path.relative(path.resolve(project), path.resolve(dir));
  return Boolean(relative) && (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative));
}

/** 校验 --out：必填且在工程外；返回绝对路径，失败时返回 { error }。 */
export function resolveOutDir(project, out) {
  if (!out) return { error: '缺少 --out <工程外证据目录>：每次结果都要保存到工程外，防止被下一次运行覆盖' };
  if (!isOutside(project, out)) return { error: '--out 必须在工程目录之外：' + out };
  return { dir: path.resolve(out) };
}

/**
 * 保存一次运行的原始报告：
 *   <out>/<name>-<时间戳>.json   本轮证据，独占创建，绝不覆盖
 *   <工程>/.mp-autocheck/<name>.json  仅作“最近一次”副本，可被覆盖，不能当证据
 */
export function saveReport(project, outDir, name, report, now = new Date()) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let file = path.join(outDir, `${name}-${stamp}.json`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(outDir, `${name}-${stamp}-${n}.json`);
  const text = JSON.stringify(report, null, 2);
  fs.writeFileSync(file, text, { flag: 'wx' });
  const latestDir = path.join(project, '.mp-autocheck');
  fs.mkdirSync(latestDir, { recursive: true });
  fs.writeFileSync(path.join(latestDir, name + '.json'), text);
  return file;
}
