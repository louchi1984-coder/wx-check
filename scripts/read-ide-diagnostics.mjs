import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { discoverDiagnosticModules } from './lib/diagnostic-modules.mjs';
import { readLocalTargets, connectLocalTarget } from './lib/local-debug.mjs';
import { resolveDebugPort } from './lib/debug-channel.mjs';
import { readEditorPanels, readDiagnosticSources } from './lib/editor-diagnostics.mjs';
const args=process.argv.slice(2);
const value=key=>args[args.indexOf('--'+key)+1];
const project=value('project'),out=value('out');
if(!args.includes('--project')||!args.includes('--out')||!project||!out)throw Error('用法：node read-ide-diagnostics.mjs --project <目标绝对路径> --out <工程外JSON文件>');
const path=await import('node:path');
const relative=path.relative(path.resolve(project),path.resolve(out));
if(!relative||(!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)))throw Error('输出必须在工程外');
const port=resolveDebugPort(args.includes('--port')?value('port'):undefined);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('端口无效');
const targets=await readLocalTargets(port);
const matches=targets.filter(t=>t.type==='page'&&/\/electron-project(?:-lite)?\.html$/.test(new URL(t.url).pathname)&&new URL(t.url).searchParams.get('projectpath')===project);
if(matches.length!==1)throw Error('目标窗口无法唯一确定');
const target=matches[0];
const address=new URL(target.webSocketDebuggerUrl);
if(address.hostname!=='127.0.0.1'||Number(address.port)!==port)throw Error('拒绝非本机连接');
if(!target)throw Error('目标工程窗口未找到');
const client=await connectLocalTarget(target,port);
const evaluate=expression=>client.evaluate(expression,20000);
try{const modules=(process.env.WECHATIDE_MODULES_DIR || path.join(path.dirname(path.dirname(fileURLToPath(target.url))),'js')).replace(/[\\/]+$/,'')+'/';
const expr=`(async()=>{
const root=${JSON.stringify(modules)},expected=${JSON.stringify(project)};
const fs=require('fs'),Buffer=require('buffer').Buffer,join=require('path').join;
const entries=fs.readdirSync(root).filter(f=>f.endsWith('.js')).map(file=>({file,source:fs.readFileSync(join(root,file),'utf8')}));
const found=(${discoverDiagnosticModules.toString()})(entries);
const store=require(join(root,found.store)).default;
if(typeof store?.getState!=='function')throw Error('状态读取能力变化');
if(store.getState().project.current.projectpath!==expected)throw Error('目标工程已变化');
const services=require(join(root,found.services)).default;
let panels;
const editorPanels=()=>{
 if(panels)return panels;
 if(!found.editor)throw Error(found.editorDiscoveryError);
 const editor=services(require(join(root,found.editor)).IEditorWorkbenchService);
 return panels=(${readEditorPanels.toString()})({editor,project:expected,fs,path:require('path')});
};
const sources=await (${readDiagnosticSources.toString()})({
 build:()=>{
  if(!found.hub)throw Error(found.hubDiscoveryError);
  const hub=services(require(join(root,found.hub)).IMessageHubService);
  if(!hub||!Array.isArray(hub.buildLogList))throw Error('构建日志能力变化');
  return {available:true,ready:hub.isBuildPanelReady,logs:[...hub.buildLogList],scope:hub.isBuildPanelReady?'面板已消费队列，不能将空队列解释为无日志':'面板未消费的当前窗口消息队列，不承诺全部历史'};
 },
 quality:async()=>{
  if(!found.quality)throw Error(found.qualityDiscoveryError);
  const quality=await new Promise((resolve,reject)=>{
   const fail=e=>{clearTimeout(timer);reject(e)};
   const timer=setTimeout(()=>fail(Error('代码质量读取超时')),8000);
   try{
    const service=services(require(join(root,found.quality)).IWebCodeQualityService);
    if(typeof service?.getCompileResultAndCheckWithProxyFunc!=='function')throw Error('代码质量读取能力变化');
    const r=service.getCompileResultAndCheckWithProxyFunc(expected,'wx-check-read-'+Date.now(),data=>{if(data.scanning===false||data.result){clearTimeout(timer);resolve(data)}},()=>{});
    if(r?.catch)r.catch(fail);
   }catch(e){fail(e)}
  });
  if(!Array.isArray(quality.result))throw Error('代码质量结果格式变化');
  return {...quality,available:true};
 },
 problems:()=>editorPanels().problems,
 output:()=>editorPanels().output,
});
return {project:expected,discoveredModules:found,time:new Date().toISOString(),...sources,limits:['按当前安装模块能力读取，逐来源保留失败与覆盖范围','问题列表与输出按当前编辑器服务读取，未初始化时需完整模式','输出偏移未知、截断或读取失败均保留','不重启、不修改源码、不清登录；质量服务会计算当前编译分析结果']};})()`;
const result=await evaluate(expr);
fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(out,JSON.stringify(result,null,2));console.log('已保存诊断证据：'+out);}finally{client.close();}
