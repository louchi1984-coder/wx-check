/** Refuse stale automation page instances before reading or writing business state. */
import { wechatide } from './wechatide.mjs';

export const activePageSource = 'function(){var p=getCurrentPages().slice(-1)[0];return p?{nativeId:p.__wxWebviewId__||p.data.__webviewId__,route:p.route}:null}';

export function assertActivePage(nativeId, automationId) {
  if (!Number.isInteger(nativeId) || nativeId <= 0 || !Number.isInteger(automationId) || automationId <= 0) {
    throw Error('无法核对当前页面实例，停止自动化操作');
  }
  if (nativeId !== automationId) {
    throw Error(`自动化页面已过期：当前运行页 ${nativeId}，自动化 ${automationId}；停止操作，需重新连接后再测`);
  }
}

export function assertPageSnapshot(native, response) {
  const page = response?.result?.currentPage;
  if (response?.ok === false || response?.result?.success === false || !native?.route || !page?.path) {
    throw Error('无法核对当前页面实例，停止自动化操作');
  }
  assertActivePage(native.nativeId, page.pageId);
  if (native.route.replace(/^\//, '') !== page.path.replace(/^\//, '')) {
    throw Error('当前运行页与自动化页面路径不一致，停止操作');
  }
  return { nativeId: native.nativeId, automationId: page.pageId, route: page.path };
}

export function assertAutomationPage(project, bin, call = wechatide) {
  const response = call('automation_evaluate', ['--project', project, '--fn-source', activePageSource], { bin, timeout: 20000 });
  if (response?.ok === false || response?.result?.success === false) throw Error('当前运行页面读取失败，停止操作');
  let native = response;
  for (let i = 0; i < 8 && native && typeof native === 'object' && 'result' in native; i++) native = native.result;
  const current = call('automation_runtime_info', ['--project', project, '--action', 'currentPage'], { bin, timeout: 20000 });
  return assertPageSnapshot(native, current);
}
