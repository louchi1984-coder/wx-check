/** 按导出能力定位当前安装的模块，不依赖打包哈希或版本号。 */
export function discoverDiagnosticModules(entries) {
  const find = (role, match) => {
    const hits = entries.filter(entry => match(entry.source));
    if (hits.length !== 1) throw Error(role + '模块无法唯一定位：' + hits.length + '；需要核对当前工具能力，不能判为无问题');
    return hits[0].file;
  };
  return {
    store: find('状态读取', source => source.includes('IStoreService') && source.includes('getState:') && source.includes('subscribe:') && source.includes('unsubscribe:') && source.includes('exports.default=function')),
    services: find('服务入口', source => source.includes('exports.getRootFactory=') && source.includes('invokeFunction') && source.includes('exports.default=')),
    hub: find('构建服务标识', source => /exports\.IMessageHubService\s*=\s*\(?/.test(source) && source.includes('createDecorator')),
    quality: find('代码质量服务标识', source => /exports\.IWebCodeQualityService\s*=/.test(source) && source.includes('createDecorator')),
  };
}
