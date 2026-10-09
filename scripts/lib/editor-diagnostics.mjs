/** 当前编辑器服务只读快照；不初始化编辑器、不切面板、不执行编辑命令。 */
export function readEditorPanels({editor,project,fs,path,maxBytes=2*1024*1024}) {
  const missing=reason=>({available:false,reason});
  if(!editor?.isInited||!editor.workbench)return {problems:missing('编辑器尚未初始化；代码测试须打开完整模式 fullMode，再重读，不重启主进程'),output:missing('编辑器尚未初始化；须先打开完整模式 fullMode')};
  const iis=editor.workbench.instantiationService;
  const decorator=editor.getVsEditorExt?.()?.createDecorator;
  const get=id=>{
    if(typeof iis?.invokeFunction!=='function'||typeof decorator!=='function')throw Error('编辑器服务访问能力变化');
    return iis.invokeFunction(accessor=>accessor.get(decorator(id)));
  };
  let problems,output;
  try{
    const service=get('markerService');
    if(typeof service?.read!=='function')throw Error('问题列表读取能力缺失');
    const markers=service.read({});
    if(!Array.isArray(markers))throw Error('问题列表格式变化');
    problems={available:true,scope:'当前工程窗口编辑器诊断列表快照，不证明所有未打开文件均已分析',markers:markers.map(m=>{
      if(typeof m?.message!=='string'||typeof m?.severity!=='number')throw Error('问题条目格式变化');
      const file=m.resource?.fsPath||null;
      const relative=file?path.relative(path.resolve(project),path.resolve(file)):null;
      return {resource:m.resource?.toString()||null,file,inProject:relative!==null&&(!relative||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)),severity:m.severity,source:m.source||m.owner||null,code:typeof m.code==='object'?m.code.value:m.code||null,message:m.message,line:m.startLineNumber||null,column:m.startColumn||null,endLine:m.endLineNumber||null,endColumn:m.endColumn||null};
    })};
  }catch(e){problems=missing(e.message)}
  try{
    const service=get('outputService');
    if(typeof service?.getChannelDescriptors!=='function'||typeof service?.getChannel!=='function')throw Error('输出通道读取能力缺失');
    const descriptors=service.getChannelDescriptors();
    if(!Array.isArray(descriptors))throw Error('输出通道列表格式变化');
    output={available:true,scope:'当前工程窗口登记的输出通道；工程、扩展及工具日志需分别解释',activeChannel:service.getActiveChannel?.()?.id||null,channels:descriptors.map(d=>{
      const row={id:d.id,label:d.label||d.id,extensionId:d.extensionId||null,file:d.file?.fsPath||null};
      try{
        const channel=service.getChannel(d.id),model=channel?.model;
        let bytes,complete=true;
        if(typeof model?.model?.getValue==='function'){
          bytes=Buffer.from(model.model.getValue(),'utf8');row.strategy='model';
        }else{
          if(d.file?.scheme!=='file'||!row.file)throw Error('通道没有已加载文本模型或本地日志文件');
          const size=fs.statSync(row.file).size;
          const hasOffset=Number.isInteger(model?.startOffset)&&model.startOffset>=0&&model.startOffset<=size;
          const start=hasOffset?model.startOffset:0;
          const fd=fs.openSync(row.file,'r');
          try{bytes=Buffer.alloc(Math.min(maxBytes,size-start));const n=fs.readSync(fd,bytes,0,bytes.length,start);bytes=bytes.subarray(0,n)}finally{fs.closeSync(fd)}
          row.strategy='file';row.startOffset=hasOffset?start:null;row.fileBytes=size;
          row.truncated=size-start>bytes.length;complete=hasOffset&&!row.truncated;
          if(!hasOffset)row.reason='已定位实际通道日志文件，但清除偏移未知；含历史记录，不等同可见面板全文';
        }
        if(bytes.length>maxBytes){bytes=bytes.subarray(0,maxBytes);row.truncated=true;complete=false}
        return {...row,available:true,complete,truncated:Boolean(row.truncated),text:bytes.toString('utf8')};
      }catch(e){return {...row,available:false,complete:false,reason:e.message}}
    })};
  }catch(e){output=missing(e.message)}
  return {problems,output};
}
