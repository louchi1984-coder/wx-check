/** 按导出能力定位当前安装的模块，不依赖打包哈希或版本号。 */
export function discoverDiagnosticModules(entries) {
  const find = (role, match) => {
    const hits = entries.filter(entry => match(entry.source));
    if (hits.length !== 1) throw Error(role + '模块无法唯一定位：' + hits.length + '；需要核对当前工具能力，不能判为无问题');
    return hits[0].file;
  };
  const editor=entries.filter(e=>/exports\.IEditorWorkbenchService\s*=/.test(e.source)&&e.source.includes('createDecorator'));
  return {
    store: find('状态读取', source => source.includes('IStoreService') && source.includes('getState:') && source.includes('subscribe:') && source.includes('unsubscribe:') && source.includes('exports.default=function')),
    services: find('服务入口', source => source.includes('exports.getRootFactory=') && source.includes('invokeFunction') && source.includes('exports.default=')),
    hub: find('构建服务标识', source => /exports\.IMessageHubService\s*=\s*\(?/.test(source) && source.includes('createDecorator')),
    quality: find('代码质量服务标识', source => /exports\.IWebCodeQualityService\s*=/.test(source) && source.includes('createDecorator')),
    editor: editor.length===1?editor[0].file:null,
    editorDiscoveryError:editor.length===1?null:'编辑器服务标识无法唯一定位：'+editor.length,
  };
}

export function discoverDeviceModules(entries) {
  const find = (role, match) => {
    const hits = entries.filter(e => match(e.source));
    if (hits.length !== 1) throw Error(role + '模块无法唯一定位：' + hits.length);
    return hits[0].file;
  };
  return {
    store: find('状态读取', s => s.includes('IStoreService') && s.includes('getState:') && s.includes('subscribe:') && s.includes('unsubscribe:') && s.includes('exports.default=function')),
    services: find('服务入口', s => s.includes('exports.getRootFactory=') && s.includes('invokeFunction') && s.includes('exports.default=')),
    actions: find('机型切换', s => s.includes('selectDevice:function') && s.includes('TOOLBAR_SELECT_DEVICE') && s.includes('toolbar.device.list')),
    bridge: find('自动化服务标识', s => /exports\.IAutomatorBridgeService\s*=/.test(s) && s.includes('createDecorator')),
  };
}
