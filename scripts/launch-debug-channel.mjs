import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { debugLaunchCommand, inspectDebugChannel } from './lib/debug-channel.mjs';
import { launchBlockReason } from './lib/prepare-debug-channel.mjs';
const args=process.argv.slice(2);
let executable,port,log,authorized=false;
for(let i=0;i<args.length;i++){
  if(args[i]==='--start-authorized'){authorized=true;continue}
  if(!['--executable','--port','--log'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw Error('用法：node scripts/launch-debug-channel.mjs --executable <已确认的实际程序> --log <新日志文件> [--port <实际端口>]');
  const key=args[i++];if(key==='--executable')executable=args[i];else if(key==='--port')port=args[i];else log=args[i];
}
if(!executable||!path.isAbsolute(executable)||!log||!path.isAbsolute(log))throw Error('程序和日志须为已确认的绝对路径；先按debug-channel.md取得授权并确认旧进程退出');
const state=await inspectDebugChannel({port});
const blocked=launchBlockReason(state,authorized);
if(blocked){console.error(JSON.stringify({status:'launch-blocked',reason:blocked,check:state}));process.exit(2)}
fs.accessSync(executable,process.platform==='win32'?fs.constants.F_OK:fs.constants.X_OK);
const command=debugLaunchCommand(executable,port);
const fd=fs.openSync(log,'wx');
try{
  fs.writeSync(fd,JSON.stringify({time:new Date().toISOString(),executable,args:command.args,removedElectronNodeMode:Boolean(process.env.ELECTRON_RUN_AS_NODE)})+'\n');
  const child=spawn(command.executable,command.args,{env:command.env,detached:true,stdio:['ignore',fd,fd]});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});
  child.unref();
  console.log(JSON.stringify({pid:child.pid,log,status:'launched-unverified',next:'启动请求已发出，尚未证明成功。独立运行check-debug-channel.mjs核对实际参数、连接与目标工程。'}));
}finally{fs.closeSync(fd)}
