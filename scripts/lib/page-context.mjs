/** Refuse stale automation page instances before reading or writing business state. */
export function assertActivePage(nativeId, automationId) {
  if (!Number.isInteger(nativeId) || nativeId <= 0 || !Number.isInteger(automationId) || automationId <= 0) {
    throw Error('无法核对当前页面实例，停止自动化操作');
  }
  if (nativeId !== automationId) {
    throw Error(`自动化页面已过期：模拟器 ${nativeId}，自动化 ${automationId}；停止操作，需重新初始化并复验`);
  }
}
