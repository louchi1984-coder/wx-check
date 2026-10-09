import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareDebugChannel } from './lib/prepare-debug-channel.mjs';
import { wechatide } from './lib/wechatide.mjs';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i++){
  if(args[i]==='--restart-authorized'){options.authorized=true;continue}
  if(!['--project','--port','--executable','--cli','--log'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw Error('用法：node scripts/prepare-debug-channel.mjs --project <工程> [--port <端口>] [--restart-authorized --executable <实际程序> --cli <官方CLI> --log <新日志>]');
  options[args[i++].slice(2)]=args[i];
}
if(!options.project||!path.isAbsolute(options.project))throw Error('工程必须是绝对路径');
if(options.authorized){
  for(const key of ['executable','cli','log'])if(!options[key]||!path.isAbsolute(options[key]))throw Error('授权启动需要实际程序、官方CLI和新日志的绝对路径');
  fs.accessSync(options.executable);fs.accessSync(options.cli);
  if(fs.existsSync(options.log))throw Error('日志已存在，禁止覆盖');
  options.quit=original=>{
    if(path.resolve(original.executable)!==path.resolve(options.executable))throw Error('当前主进程与指定程序不一致，停止退出');
    wechatide('quit',[],{bin:options.cli,timeout:10000});
  };
  options.launch=()=>{
    const flags=['--executable',options.executable,'--log',options.log,'--start-authorized'];
    if(options.port)flags.push('--port',options.port);
    const r=spawnSync(process.execPath,[fileURLToPath(new URL('./launch-debug-channel.mjs',import.meta.url)),...flags],{encoding:'utf8',timeout:10000});
    if(r.error||r.status!==0)throw Error(r.error?.message||r.stderr||'启动器失败');
    return JSON.parse(r.stdout);
  };
  options.readLog=()=>fs.existsSync(options.log)?fs.readFileSync(options.log,'utf8'):'';
}
try{
  const result=await prepareDebugChannel(options);
  console.log(JSON.stringify(result,null,2));
  process.exitCode=result.status==='ready'?0:2;
}catch(e){console.error(JSON.stringify({status:'preparation-failed',reason:e.message}));process.exitCode=2}
