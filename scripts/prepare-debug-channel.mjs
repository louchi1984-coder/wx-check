import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareDebugChannel } from './lib/prepare-debug-channel.mjs';
import { debugLaunchCommand } from './lib/debug-channel.mjs';
import { wechatide } from './lib/wechatide.mjs';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i++){
  if(args[i]==='--restart-authorized'){options.authorized=true;continue}
  if(!['--project','--port','--executable','--cli','--log','--wait-ms','--launch-method'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw Error('用法：node scripts/prepare-debug-channel.mjs --project <工程> [--port <端口>] [--wait-ms <等待预算>] [--restart-authorized --executable <实际程序> --cli <官方CLI> --log <日志>]');
  const key=args[i++].slice(2);options[key==='wait-ms'?'waitMs':key]=args[i];
}
if(!options.project||!path.isAbsolute(options.project))throw Error('工程必须是绝对路径');
if(options.authorized){
  if(!options.executable||!path.isAbsolute(options.executable))throw Error('授权启动需要实际程序绝对路径');
  fs.accessSync(options.executable);
  if(options.cli)fs.accessSync(options.cli);
  options.log=options.log||path.join(os.tmpdir(),'wx-check-debug-'+randomUUID()+'.log');
  if(!path.isAbsolute(options.log))throw Error('日志须为绝对路径');
  if(fs.existsSync(options.log))options.log=path.join(path.dirname(options.log),path.basename(options.log)+'.'+randomUUID());
  fs.mkdirSync(path.dirname(options.log),{recursive:true});
  options.quit=original=>{
    if(path.resolve(original.executable)!==path.resolve(options.executable))throw Error('当前主进程与指定程序不一致，停止退出');
    const response=wechatide('quit',[],{bin:options.cli,timeout:10000});
    if(response.ok===false||response.result?.success!==true)throw Object.assign(Error('官方CLI未确认正常退出'),{output:JSON.stringify(response)});
  };
  options.validateLaunch=()=>debugLaunchCommand(options.executable,options.port,process.env,{log:options.log,method:options['launch-method']});
  options.launch=()=>{
    const flags=['--executable',options.executable,'--log',options.log,'--start-authorized'];
    if(options.port)flags.push('--port',options.port);
    if(options['launch-method'])flags.push('--launch-method',options['launch-method']);
    const r=spawnSync(process.execPath,[fileURLToPath(new URL('./launch-debug-channel.mjs',import.meta.url)),...flags],{encoding:'utf8',timeout:10000});
    if(r.error||r.status!==0)throw Object.assign(Error(r.error?.message||r.stderr||'启动器失败'),{code:r.error?.code,exitCode:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr});
    try{return JSON.parse(r.stdout)}catch(e){throw Object.assign(Error('启动器结果格式异常：'+e.message),{exitCode:r.status,stdout:r.stdout,stderr:r.stderr})}
  };
  options.readLog=()=>[options.log,options.log+'.stdout.log',options.log+'.stderr.log'].filter(file=>fs.existsSync(file)).map(file=>fs.readFileSync(file,'utf8')).join('\n');
}
try{
  const result=await prepareDebugChannel(options);
  if(options.log)result.launchLog={path:options.log,available:fs.existsSync(options.log)};
  console.log(JSON.stringify(result,null,2));
  process.exitCode=result.status==='ready'?0:2;
}catch(e){console.error(JSON.stringify({status:'preparation-failed',reason:e.message}));process.exitCode=2}
