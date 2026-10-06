import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { discoverDiagnosticModules } from './lib/diagnostic-modules.mjs';
const args=process.argv.slice(2);
const value=key=>args[args.indexOf('--'+key)+1];
const project=value('project'),out=value('out');
if(!args.includes('--project')||!args.includes('--out')||!project||!out)throw Error('用法：node read-ide-diagnostics.mjs --project <目标绝对路径> --out <工程外JSON文件>');
const path=await import('node:path');
const relative=path.relative(path.resolve(project),path.resolve(out));
if(!relative||(!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)))throw Error('输出必须在工程外');
const port=Number(args.includes('--port')?value('port'):9223);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('端口无效');
const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(5000)})).json();
const matches=targets.filter(t=>t.type==='page'&&/\/electron-project(?:-lite)?\.html$/.test(new URL(t.url).pathname)&&new URL(t.url).searchParams.get('projectpath')===project);
if(matches.length!==1)throw Error('目标窗口无法唯一确定');
const target=matches[0];
const address=new URL(target.webSocketDebuggerUrl);
if(address.hostname!=='127.0.0.1'||Number(address.port)!==port)throw Error('拒绝非本机连接');
if(!target)throw Error('目标工程窗口未找到');
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;setTimeout(()=>reject(Error('连接超时')),5000).unref();});
let id=0;
async function evaluate(expression){const n=++id;return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('读取超时')),10000);const handler=event=>{const r=JSON.parse(event.data);if(r.id!==n)return;ws.removeEventListener('message',handler);clearTimeout(timer);r.error?reject(Error(r.error.message)):r.result.exceptionDetails?reject(Error(JSON.stringify(r.result.exceptionDetails))):resolve(r.result.result.value);};ws.addEventListener('message',handler);ws.send(JSON.stringify({id:n,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));});}
try{const modules=(process.env.WECHATIDE_MODULES_DIR || path.join(path.dirname(path.dirname(fileURLToPath(target.url))),'js')).replace(/[\\/]+$/,'')+'/';
const expr=`(async()=>{const root=${JSON.stringify(modules)};const expected=${JSON.stringify(project)};const fs=require('fs');const join=require('path').join;const entries=fs.readdirSync(root).filter(f=>f.endsWith('.js')).map(file=>({file,source:fs.readFileSync(join(root,file),'utf8')}));const found=(${discoverDiagnosticModules.toString()})(entries);const store=require(join(root,found.store)).default;if(typeof store?.getState!=='function')throw Error('状态读取能力变化');const state=store.getState();if(state.project.current.projectpath!==expected)throw Error('目标工程已变化');const services=require(join(root,found.services)).default;const hub=services(require(join(root,found.hub)).IMessageHubService);if(!hub||!Array.isArray(hub.buildLogList))throw Error('构建日志能力变化');const build={ready:hub.isBuildPanelReady,logs:[...(hub.buildLogList||[])],scope:hub.isBuildPanelReady?'面板已消费队列，不能将空队列解释为无日志':'面板未消费的当前窗口消息队列，不承诺全部历史'};const quality=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('代码质量读取超时')),8000);try{const qualityService=services(require(join(root,found.quality)).IWebCodeQualityService);if(typeof qualityService?.getCompileResultAndCheckWithProxyFunc!=='function')throw Error('代码质量读取能力变化');const r=qualityService.getCompileResultAndCheckWithProxyFunc(expected,'wx-check-read-'+Date.now(),data=>{if(data.scanning===false||data.result){clearTimeout(timer);resolve(data);}},()=>{});if(r?.catch)r.catch(reject);}catch(e){clearTimeout(timer);reject(e);}});if(!Array.isArray(quality.result))throw Error('代码质量结果格式变化');return {project:expected,discoveredModules:found,time:new Date().toISOString(),quality,build,limits:['非官方CLI接口，运行时按能力定位当前安装模块；能力结构变化时明确报告并转其他读取方式','不读取编辑器问题与输出通道，此两项另用可访问性或匹配原始日志','不重启、不修改源码、不清登录；质量服务会计算当前编译分析结果']};})()`;
const result=await evaluate(expr);
fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(out,JSON.stringify(result,null,2));console.log('已保存诊断证据：'+out);}finally{ws.close();}
