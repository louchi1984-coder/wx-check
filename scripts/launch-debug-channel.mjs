import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { debugLaunchCommand, inspectDebugChannel } from './lib/debug-channel.mjs';
import { launchBlockReason } from './lib/prepare-debug-channel.mjs';
const args=process.argv.slice(2);
let executable,port,log,method,authorized=false;
for(let i=0;i<args.length;i++){
  if(args[i]==='--start-authorized'){authorized=true;continue}
  if(!['--executable','--port','--log','--launch-method'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw Error('用法：node scripts/launch-debug-channel.mjs --executable <已确认的实际程序> --log <新日志文件> [--port <实际端口>]');
  const key=args[i++];if(key==='--executable')executable=args[i];else if(key==='--port')port=args[i];else if(key==='--log')log=args[i];else method=args[i];
}
if(!executable||!path.isAbsolute(executable)||!log||!path.isAbsolute(log))throw Error('程序和日志须为已确认的绝对路径；先按debug-channel.md取得授权并确认旧进程退出');
if(method&&!['direct','application'].includes(method))throw Error('launch-method须为direct或application');
const command=debugLaunchCommand(executable,port,process.env,{log,method});
const state=await inspectDebugChannel({port});
const blocked=launchBlockReason(state,authorized);
if(blocked){console.error(JSON.stringify({status:'launch-blocked',reason:blocked,check:state}));process.exit(2)}
fs.accessSync(executable,process.platform==='win32'?fs.constants.F_OK:fs.constants.X_OK);
const fd=fs.openSync(log,'wx');
try{
  fs.writeSync(fd,JSON.stringify({time:new Date().toISOString(),executable,launcher:command.executable,method:command.method,args:command.args,removedElectronNodeMode:Boolean(process.env.ELECTRON_RUN_AS_NODE)})+'\n');
  const child=spawn(command.executable,command.args,{env:command.env,detached:true,stdio:['ignore',fd,fd]});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});
  child.unref();
  console.log(JSON.stringify({launcherPid:child.pid,log,method:command.method,status:'launched-unverified',next:'启动请求已发出，尚未证明成功。独立运行check-debug-channel.mjs核对实际参数、连接与目标工程。'}));
}finally{fs.closeSync(fd)}
