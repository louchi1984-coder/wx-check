import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { resolveDebugPort, inspectDebugChannel, debugLaunchCommand, parseMacProcesses } from './lib/debug-channel.mjs';
import { prepareDebugChannel, launchBlockReason } from './lib/prepare-debug-channel.mjs';
import { readLocalTargets } from './lib/local-debug.mjs';
let passed=0;
const test=async(name,fn)=>{await fn();passed++;console.log('通过：'+name)};
await test('端口优先显式参数，再环境变量，再默认值',()=>{
  assert.equal(resolveDebugPort(undefined,{}),9223);
  assert.equal(resolveDebugPort(undefined,{WECHATIDE_DEBUG_PORT:'9333'}),9333);
  assert.equal(resolveDebugPort('9444',{WECHATIDE_DEBUG_PORT:'9333'}),9444);
  assert.throws(()=>resolveDebugPort('0'),/端口/);
});
const noProcess=()=>({checked:true,processes:[]});
await test('GUI启动仅移除子进程Node模式，保留安全钩子与父环境',()=>{
  const env={ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:'--require=/security/hook.cjs',NODE_REPL_EXTERNAL_MODULE:'/security/repl.cjs',PATH:'/bin',WECHATIDE_DEBUG_PORT:'9333'};
  const r=debugLaunchCommand('/real/Electron',undefined,env);
  assert.deepEqual(r.args,['--remote-debugging-address=127.0.0.1','--remote-debugging-port=9333']);
  assert.equal(r.env.ELECTRON_RUN_AS_NODE,undefined);assert.equal(env.ELECTRON_RUN_AS_NODE,'1');
  for(const key of ['NODE_OPTIONS','NODE_REPL_EXTERNAL_MODULE','PATH'])assert.equal(r.env[key],env[key]);
});
await test('启动前检查揭示Node模式，不只报告端口拒绝',async()=>{
  const r=await inspectDebugChannel({env:{ELECTRON_RUN_AS_NODE:'1'},read:async()=>{throw Object.assign(Error('refused'),{code:'ECONNREFUSED'})},processInfo:noProcess});
  assert.equal(r.environment.electronNodeModeVariableSet,true);assert.match(r.advice,/ELECTRON_RUN_AS_NODE/);
});
await test('未监听且进程无参数：明确缺参数，不继续等待',async()=>{
  const r=await inspectDebugChannel({read:async()=>{throw Object.assign(Error('refused'),{code:'ECONNREFUSED'})},processInfo:()=>({checked:true,processes:[{pid:12,executable:'/app/Electron',debugPort:null}]})});
  assert.equal(r.status,'not-listening');assert.match(r.advice,/参数/);assert.equal(r.processes[0].debugPort,null);
});
await test('进程读取被沙箱挡住时不冒充已退出',async()=>{
  const r=await inspectDebugChannel({read:async()=>{throw Object.assign(Error('refused'),{code:'ECONNREFUSED'})},processInfo:()=>({checked:false,error:'operation not permitted'})});
  assert.equal(r.processCheck.checked,false);assert.match(r.advice,/权限/);
});
await test('连接权限失败与未监听分开',async()=>{
  const r=await inspectDebugChannel({read:async()=>{throw Object.assign(Error('denied'),{code:'EPERM'})},processInfo:noProcess});
  assert.equal(r.status,'permission-blocked');
});
await test('另一个端口已在进程参数中时报告差异',async()=>{
  const r=await inspectDebugChannel({port:9223,read:async()=>{throw Object.assign(Error('refused'),{code:'ECONNREFUSED'})},processInfo:()=>({checked:true,processes:[{pid:12,executable:'/app/Electron',debugPort:9333}]})});
  assert.match(r.advice,/9333/);
});
await test('实际HTTP目标按工程路径定位且不返回内部连接令牌',async()=>{
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{type:'page',url:'file:///app/electron-project.html?projectpath=%2Ffixture&token=private',webSocketDebuggerUrl:'ws://127.0.0.1/private'}]))});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const r=await inspectDebugChannel({port:server.address().port,project:'/fixture',processInfo:noProcess});
    assert.equal(r.status,'ready');assert.equal(r.projectMatches,1);assert.doesNotMatch(JSON.stringify(r),/private/);
  }finally{await new Promise(resolve=>server.close(resolve))}
});
await test('HTTP非目标列表不能算通道就绪',async()=>{
  const server=http.createServer((req,res)=>res.end('{}'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await assert.rejects(readLocalTargets(server.address().port),/格式异常/)}finally{await new Promise(resolve=>server.close(resolve))}
});
await test('真实诊断入口使用环境指定端口，不回落到9223',async()=>{
  let requested=false;
  const server=http.createServer((req,res)=>{requested=true;res.end('[]')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const r=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(new URL('./read-ide-diagnostics.mjs',import.meta.url)),'--project','/fixture','--out',path.join(os.tmpdir(),'wx-check-channel-'+process.pid+'.json')],{env:{...process.env,WECHATIDE_DEBUG_PORT:String(server.address().port)}});
      let error='';child.stderr.on('data',b=>error+=b);child.on('error',reject);child.on('close',code=>resolve({code,error}));
    });
    assert.equal(requested,true);assert.notEqual(r.code,0);assert.match(r.error,/目标窗口无法唯一确定/);
  }finally{await new Promise(resolve=>server.close(resolve))}
});
const missing={status:'not-listening',processCheck:{checked:true},processes:[],advice:'未监听'};
await test('启动命令参数里的程序路径不误认成主进程',()=>{
  const exe='/Applications/wechatwebdevtools.app/Contents/MacOS/Electron';
  const processes=parseMacProcesses('12 '+exe+' --remote-debugging-port=9223\n13 node scripts/launch-debug-channel.mjs --executable '+exe+'\n14 /usr/local/bin/node scripts/launch-debug-channel.mjs --executable '+exe+'\n15 '+exe+' --type=renderer');
  assert.deepEqual(processes,[{pid:12,executable:exe,debugPort:9223}]);
});
const ordinary={...missing,processes:[{pid:12,executable:'/app/Electron',debugPort:null}]};
await test('受限环境在退出之前停止，即使带了授权标志也不启动',async()=>{
  let calls=0;
  const blocked={...ordinary,processCheck:{checked:false,error:'Operation not permitted'}};
  const r=await prepareDebugChannel({authorized:true,check:async()=>blocked,quit:()=>calls++,launch:()=>calls++});
  assert.equal(r.status,'execution-blocked');assert.equal(calls,0);assert.match(launchBlockReason(blocked,true),/执行环境/);
});
await test('已有通道或工程窗口未匹配时都不重启',async()=>{
  for(const projectMatches of [0,1,2]){
    let calls=0;
    const r=await prepareDebugChannel({project:'/fixture',authorized:true,check:async()=>({...missing,status:'ready',projectMatches}),quit:()=>calls++,launch:()=>calls++});
    assert.equal(r.status,projectMatches===1?'ready':'project-unresolved');assert.equal(calls,0);
  }
});
await test('未授权或实际端口不同不退出、不启动',async()=>{
  let calls=0;
  const options={quit:()=>calls++,launch:()=>calls++};
  assert.equal((await prepareDebugChannel({...options,check:async()=>ordinary})).status,'authorization-required');
  assert.equal((await prepareDebugChannel({...options,authorized:true,check:async()=>({...ordinary,processes:[{pid:12,debugPort:9333}]})})).status,'inspection-required');
  assert.equal(calls,0);
});
await test('低层启动器也拒绝旧实例、缺授权和不明确通道',()=>{
  assert.match(launchBlockReason(ordinary,true),/第二实例/);
  assert.match(launchBlockReason(missing,false),/授权/);
  assert.match(launchBlockReason({...missing,status:'unreachable'},true),/不明确/);
  assert.equal(launchBlockReason(missing,true),null);
});
await test('正常准备只退出一次、启动一次，并核对真实通道',async()=>{
  let checks=0,quits=0,starts=0;
  const r=await prepareDebugChannel({project:'/fixture',authorized:true,check:async()=>[ordinary,missing,{...missing,status:'ready',projectMatches:1}][checks++],quit:()=>quits++,launch:()=>({pid:++starts})});
  assert.equal(r.status,'ready');assert.equal(quits,1);assert.equal(starts,1);assert.equal(checks,3);
});
await test('退出状态不明确时禁止启动和强杀',async()=>{
  let checks=0,starts=0,time=0;
  const r=await prepareDebugChannel({authorized:true,check:async()=>{checks++;return ordinary},quit:()=>{},launch:()=>starts++,now:()=>time,pause:async ms=>{time+=ms}});
  assert.equal(r.status,'exit-unconfirmed');assert.equal(starts,0);assert.equal(time,15000);
});
await test('启动沙箱错误即停止，假就绪不覆盖原始失败，不重试',async()=>{
  let checks=0,starts=0;
  const r=await prepareDebugChannel({authorized:true,check:async()=>++checks===1?missing:{...missing,status:'ready'},launch:()=>starts++,readLog:()=> 'sandbox initialization failed: Operation not permitted'});
  assert.equal(r.status,'startup-failed');assert.equal(starts,1);assert.equal(checks,2);
});
await test('持续未监听最多等待30秒，只启动一次',async()=>{
  let time=0,starts=0;
  const r=await prepareDebugChannel({authorized:true,check:async()=>missing,launch:()=>starts++,now:()=>time,pause:async ms=>{time+=ms}});
  assert.equal(r.status,'startup-failed');assert.equal(time,30000);assert.equal(starts,1);
});
await test('真实诊断入口不调用CLI，也不打开或刷新工程',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wx-check-no-cli-'));
  const project=path.join(dir,'project'),out=path.join(dir,'evidence'),marker=path.join(dir,'cli-called');
  fs.mkdirSync(project);fs.writeFileSync(path.join(project,'app.json'),'{}');
  const cli=path.join(dir,'cli.cjs');
  fs.writeFileSync(cli,'#!/usr/bin/env node\nrequire("fs").writeFileSync('+JSON.stringify(marker)+',"called");process.exit(1)');fs.chmodSync(cli,0o755);
  const server=http.createServer((req,res)=>res.end('[]'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const r=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(new URL('./read-ide-diagnostics.mjs',import.meta.url)),'--project',project,'--out',path.join(out,'diagnostics.json')],{env:{...process.env,WECHATIDE_BIN:cli,WECHATIDE_DEBUG_PORT:String(server.address().port)}});
      let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);child.on('error',reject);child.on('close',code=>resolve({code,output,error}));
    });
    assert.equal(fs.existsSync(marker),false);assert.equal(r.code,1);assert.match(r.error,/目标窗口无法唯一确定/);
  }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true})}
});
console.log(passed+' 项调试通道回归通过');
