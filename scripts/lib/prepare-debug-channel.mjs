import { inspectDebugChannel } from './debug-channel.mjs';

/** 启动器也独立执行此检查，不能跳过准备入口进入已知失败路径。 */
export function launchBlockReason(state,authorized) {
  if(state.status==='ready')return '已有调试通道，复用，不启动第二实例。';
  if(state.status==='protocol-unavailable')return 'HTTP通道已开启，协议未通过；保留错误，不启动第二实例。';
  if(!state.processCheck.checked||state.status==='permission-blocked')return '当前执行环境无法核对进程或访问通道。保留错误，按debug-channel.md提供已填好路径的用户终端或CMD命令，不能把读取失败当成无进程。';
  if(state.processes.length)return '开发者工具主进程仍在运行，禁止启动第二实例。';
  if(state.status!=='not-listening')return '通道状态不明确，停止启动并保留原始错误。';
  if(!authorized)return '尚未确认启动授权；取得用户许可后才能启动。';
  return null;
}

/** 通道准备：先检查，许可和执行条件齐备后正常退出一次、启动一次。 */
export async function prepareDebugChannel({port,project,authorized=false,waitMs=30000,check=inspectDebugChannel,quit,launch,validateLaunch=()=>{},readLog=()=>'',now=Date.now,pause=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  if(!Number.isFinite(Number(waitMs))||Number(waitMs)<=0)throw Error('wait-ms必须为正数');
  waitMs=Number(waitMs);
  const inspect=()=>check({port,project});
  let state=await inspect();
  let launchWarnings=[];
  const result=(status,reason,extra={})=>({status,reason,check:state,...(launchWarnings.length?{launchWarnings}:{}),...extra});
  const failed=(status,e)=>result(status,e.message,{error:Object.fromEntries(['message','code','exitCode','signal','stdout','stderr','output'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]]))});
  if(state.status==='ready')return result(project&&state.projectMatches!==1?'project-unresolved':'ready',state.advice);
  if(state.status==='protocol-unavailable')return result('protocol-unavailable',state.advice);
  if(!state.processCheck.checked||state.status==='permission-blocked')return result('execution-blocked',launchBlockReason(state,authorized));
  if(state.processes.some(p=>p.debugPort!==null)||state.status!=='not-listening')return result('inspection-required',state.advice);
  if(!authorized)return result('authorization-required','需正常退出并带调试参数启动一次；先取得用户许可。');
  if(state.processes.length>1)return result('inspection-required','主进程不唯一，不能猜测退出目标。');
  if(!launch||state.processes.length&&!quit)return result('configuration-required','授权启动还需要已确认的程序、官方CLI和日志位置。');
  try{validateLaunch()}catch(e){return failed('configuration-required',e)}
  if(state.processes.length){
    const original=state.processes[0];
    try{await quit(original)}catch(e){return failed('quit-failed',e)}
    const deadline=now()+waitMs;
    do{
      state=await inspect();
      if(!state.processCheck.checked)return result('execution-blocked','退出后的进程状态无法核对；不继续启动。');
      if(!state.processes.length)break;
      if(now()>=deadline)return result('exit-pending','本次等待结束，尚未确认退出；继续只读核对，不强杀、不重复发退出命令。');
      await pause(500);
    }while(true);
  }
  const blocked=launchBlockReason(state,true);
  if(blocked)return result('launch-blocked',blocked);
  let started;
  try{started=await launch()}catch(e){return failed('startup-failed',e)}
  const deadline=now()+waitMs;
  do{
    state=await inspect();
    const text=readLog();
    launchWarnings=text.split(/\r?\n/).filter(line=>/sandbox initialization failed|Failed to initialize sandbox|FATAL:|GPU process isn't usable|SingletonLock.*(?:Operation not permitted|File exists)|bad option/i.test(line)).slice(0,20);
    if(/GPU process isn't usable|FATAL:/i.test(text)||launchWarnings.length&&!(state.status==='ready'&&state.protocol?.available===true))return result('startup-failed','启动日志记录致命错误或通道尚未通过实际协议核验；保留日志，转用户系统终端，不重复启动。',{started});
    if(state.status==='ready')return result(project&&state.projectMatches!==1?'project-unresolved':'ready',state.advice,{started});
    if(state.status==='protocol-unavailable')return result('protocol-unavailable',state.advice,{started});
    if(!state.processCheck.checked||state.status==='permission-blocked')return result('execution-blocked','启动后的检查受到权限限制；停止重复尝试。',{started});
    if(state.status==='not-listening'&&state.processes.length&&state.processes.every(p=>p.debugPort===null))return result('startup-failed','主进程已启动但未带调试参数，继续等待不会开启端口；保留现有窗口，转用户系统终端。',{started});
    if(now()>=deadline)return result('starting','本次等待结束，尚未取得真实通道；保留进程和日志，稍后只读复查，不把等待结束判成启动失败。',{started});
    await pause(500);
  }while(true);
}
