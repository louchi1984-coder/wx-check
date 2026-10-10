import { inspectDebugChannel, resolveDebugPort } from './lib/debug-channel.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const args=process.argv.slice(2);
let port,project,out;
for(let i=0;i<args.length;i++){
  if(!['--port','--project','--out'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw Error('用法：node scripts/check-debug-channel.mjs [--port <实际端口>] [--project <工程绝对路径>] [--out <工程外新JSON>]');
  const key=args[i++];if(key==='--port')port=args[i];else if(key==='--project')project=args[i];else out=args[i];
}
if(out){
  if(!project||!path.isAbsolute(project)||!path.isAbsolute(out))throw Error('保存连接信息需要工程和输出绝对路径');
  const relative=path.relative(path.resolve(project),path.resolve(out));
  if(!relative||(!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)))throw Error('连接信息必须在工程外');
}
const result=await inspectDebugChannel({port:resolveDebugPort(port),project});
result.cli={bin:process.env.WECHATIDE_BIN||'wechatide',client:process.env.WECHATIDE_CLIENT||'miniprogram-autocheck'};
if(out){
  if(fs.existsSync(out))out=path.join(path.dirname(out),path.basename(out)+'.'+randomUUID()+'.json');
  fs.mkdirSync(path.dirname(out),{recursive:true});
  result.connectionFile=out;
  fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
}
console.log(JSON.stringify(result,null,2));
process.exitCode=result.status==='ready'&&(!project||result.projectMatches===1)?0:2;
