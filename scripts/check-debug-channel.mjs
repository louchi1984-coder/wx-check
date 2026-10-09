import { inspectDebugChannel, resolveDebugPort } from './lib/debug-channel.mjs';
const args=process.argv.slice(2);
let port,project;
for(let i=0;i<args.length;i++){
  if(!['--port','--project'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw Error('用法：node scripts/check-debug-channel.mjs [--port <实际端口>] [--project <工程绝对路径>]');
  const key=args[i++];if(key==='--port')port=args[i];else project=args[i];
}
const result=await inspectDebugChannel({port:resolveDebugPort(port),project});
console.log(JSON.stringify(result,null,2));
process.exitCode=result.status==='ready'&&(!project||result.projectMatches===1)?0:2;
