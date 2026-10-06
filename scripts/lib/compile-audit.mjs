/**
 * 模块 D · 真编译（用开发者工具真的编一遍）
 *
 * 与模块 A 的区别：A 是拿正则扫代码文本，只能看出「引用了不存在的图片/页面」这类结构问题；
 * 本模块把工程的 wxml / wxss 交给开发者工具**真的编译一次**，编不过就是编不过。
 *
 * ★ 关键实测结论（v0.3.11，务必不要改回去）：
 *   `--file-path` **不是「只编这一个文件」**，而是「以它为入口触发一次**整个工程**的编译」，
 *   返回的是整个工程的编译结果。
 *   实测证据：夹具里 ok.wxml 完全正确，但工程内 bad.wxml 有语法错时，
 *   编 ok.wxml 返回的报错是 `./pages/bad/bad.wxml:4:1: unexpected end`——与编 bad.wxml 的返回逐字相同。
 *   因此**绝不能把结果归因到 --file-path 指定的那个文件**，那会把无辜文件报成「编译不通过」，
 *   且同一个错误会按文件数重复报（夹具 2 个错被报成 4 个文件）。
 *   正确做法：wxml / wxss **各只调一次**，再从错误信息里解析真实出错的文件路径。
 *
 *   返回结构：
 *     成功 compile_wxml → { ok:true, result:{ success:true, codeLength } }
 *     成功 compile_wxss → { ok:true, result:{ success:true, files, fileList, totalCodeLength } }
 *     失败              → { ok:false, errorType:'MCP_TOOL_ERROR', message:'...' }（进程退出码 1）
 *   判据：result.success 不为 true 就是没编过，错误原因在 message 里。
 *
 * 依赖：需要项目窗口已打开（与模块 B/C 同一前置条件）。
 */
import fs from 'fs';
import path from 'path';
import { wechatide } from './wechatide.mjs';

/** 不参与编译的目录：第三方产物与自检产物 */
const SKIP_DIRS = new Set([
  'node_modules',
  'miniprogram_npm',
  '.mp-autocheck',
  '.git',
  '.archive',
  'dist',
  'build',
]);

/** 列出所有待编译的 wxml / wxss（相对于工程根，正斜杠） */
export function listCompileTargets(project) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
        continue;
      }
      if (/\.(wxml|wxss)$/.test(e.name)) {
        out.push(path.relative(project, full).split(path.sep).join('/'));
      }
    }
  };
  walk(project);
  return out.sort();
}

/**
 * npm 构建情况：只查、不构建。
 * build_npm 会改本地产物，属于写操作，按约定不自动跑，只在没构建时提示。
 */
export function checkNpm(project) {
  const pkgPath = path.join(project, 'package.json');
  if (!fs.existsSync(pkgPath)) return { hasNpm: false };
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return { hasNpm: false, parseError: true };
  }
  const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
  if (!deps.length) return { hasNpm: false };
  const built = fs.existsSync(path.join(project, 'miniprogram_npm'));
  return { hasNpm: true, deps: deps.length, built, names: deps.slice(0, 5) };
}

/** 官方在错误指引里点名的「环境/配置」类错误码，这些不是文件编不过 */
const ENV_CODES = new Set(['APPID_ERROR', 'PROJECT_PATH_NOT_FOUND', 'PROJECT_CONFIG_JSON_ERROR']);

/** 以工程配置文件开头的报错属于全局问题（如 app.json 有重复页面），编译器会先卡在这里，任何文件都编不过 */
const GLOBAL_MSG = /^\s*(app\.json|project\.config\.json)\s*[:：]/;

/**
 * 从编译错误信息里反查真实出错的文件。
 *
 * 错误信息形如：
 *   `编译 .wxml 文件错误，错误信息如上，可在控制台查看更详细信息 ./pages/bad/bad.wxml:4:1: unexpected end`
 *
 * 注意坑：信息里出现的 `.wxss` / `.wxml` 这类「光秃秃的扩展名」不是文件，正则必须要求
 * 文件名以字母数字开头（`[\w-]+`），因此 `.wxss` 不会被误当成文件。
 * 再用「该路径在工程里确实存在」做二次确认，把误匹配彻底挡掉。
 *
 * @param {string} msg 原始错误信息
 * @param {string} project 工程绝对路径（用于存在性校验）
 * @returns {string[]} 真实出错的文件（相对路径，去重、保序）
 */
export function parseErrorFiles(msg, project) {
  const re = /(?:^|[\s(:，,、"'`])((?:\.\/)?[\w-]+(?:\/[\w-]+)*\.(?:wxml|wxss|wxs|json|js))(?::(\d+):(\d+))?/g;
  const seen = [];
  let m;
  while ((m = re.exec(String(msg || ''))) !== null) {
    const raw = m[1].replace(/^\.\//, '');
    const hit = project ? path.join(project, raw.split('/').join(path.sep)) : null;
    if (project && !fs.existsSync(hit)) continue;
    if (!seen.includes(raw)) seen.push(raw);
  }
  return seen;
}

/**
 * @param {string} project 工程绝对路径
 * @param {string|null} bin CLI 路径
 * @param {Function} log
 * @param {{timeout?:number, maxChannelFail?:number}} opts
 */
export function auditCompile(project, bin, log = () => {}, opts = {}) {
  const { timeout = 120000, maxChannelFail = 2 } = opts;
  const all = listCompileTargets(project);
  const wxmls = all.filter((f) => f.endsWith('.wxml'));
  const wxsss = all.filter((f) => f.endsWith('.wxss'));

  const stats = {
    files: all.length,
    wxml: wxmls.length,
    wxss: wxsss.length,
    jobs: 0,
    ok: 0,
    failed: 0,
    globalFail: 0,
    globalMsg: '',
    channelFail: 0,
    aborted: false,
  };

  // 每类只调一次（见文件头「关键实测结论」）。入口文件随便挑一个，编译结果与挑哪个无关。
  const jobs = [];
  if (wxmls.length) jobs.push({ tool: 'compile_wxml', kind: 'wxml', entry: wxmls[0], total: wxmls.length });
  if (wxsss.length) jobs.push({ tool: 'compile_wxss', kind: 'wxss', entry: wxsss[0], total: wxsss.length });

  const issues = [];
  const globalMsgs = [];
  let sawStructured = false; // 是否至少拿到过一次「能用的结论」（通过 或 具体编译错）

  for (const job of jobs) {
    stats.jobs++;
    let r;
    try {
      r = wechatide(job.tool, ['--project', project, '--file-path', job.entry], { bin, timeout });
    } catch (e) {
      // 没有 JSON 返回 = 通道问题（超时/连接断），不是代码问题，绝不能记成「编译失败」
      stats.channelFail++;
      if (stats.channelFail >= maxChannelFail) {
        stats.aborted = true;
        break;
      }
      continue;
    }

    const res = r.result || {};
    if (r.ok !== false && res.success !== false) {
      stats.ok++;
      sawStructured = true;
      continue;
    }

    const raw = String(r.message || res.error || '未知编译错误').replace(/\s+/g, ' ').trim();
    const code = String(r.reason || r.code || '');

    // AppID 无效 / 路径不对 / 工程配置有问题 —— 不是文件编不过。
    // 实测：工程 app.json 里页面重复时，编译器回 `app.json: "pages/x" 在 ["pages"] 中重复`。
    if (ENV_CODES.has(code) || GLOBAL_MSG.test(raw)) {
      stats.globalFail++;
      if (!stats.globalMsg) stats.globalMsg = raw;
      globalMsgs.push(raw);
      continue;
    }

    stats.failed++;
    sawStructured = true;

    // 从报错里反查真实出错的文件；查不到就只能说「这一类整体编不过」，不点名文件
    const files = parseErrorFiles(raw, project);
    const where = files.length
      ? files.length > 3
        ? files.slice(0, 3).join('、') + ' 等 ' + files.length + ' 个文件'
        : files.join('、')
      : '全部 .' + job.kind + '（共 ' + job.total + ' 个，报错里没给出文件名，需在开发者工具控制台查看）';

    issues.push({
      level: 'P0',
      rule: '编译不通过',
      where,
      msg: raw.slice(0, 400),
      fix: '先修到能编译通过（标签闭合、指令拼写、表达式语法），再谈其他检查项',
    });
  }

  const npm = checkNpm(project);
  if (npm.hasNpm && !npm.built) {
    issues.push({
      level: 'P1',
      rule: 'npm 未构建',
      where: 'package.json',
      msg: '声明了 ' + npm.deps + ' 个 npm 依赖（' + npm.names.join('、') + '），但工程里没有 miniprogram_npm 构建产物',
      fix: '在开发者工具里执行「工具 → 构建 npm」。注意：这一步会改本地产物，本工具不自动执行',
    });
  }

  if (stats.aborted) {
    log('  ! 连续 ' + stats.channelFail + ' 次通道无响应，已中止（未编到的类型不计入结论）');
  }

  // 一次都没拿到能用的结论、且原因在工程配置/AppID —— 本模块给不出结论，如实标记为不可用
  if (!sawStructured && stats.globalFail > 0) {
    return {
      issues,
      stats,
      npm,
      unavailable: true,
      reason: stats.globalMsg || '工程配置导致无法编译',
    };
  }
  return { issues, stats, npm };
}
