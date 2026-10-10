import { inspectDebugChannel } from './debug-channel.mjs';

/** 启动器也独立执行此检查，不能跳过准备入口进入已知失败路径。 */
export function launchBlockReason(state,authorized) {
  if(state.status==='ready')return '已有调试通道，复用，不启动第二实例。';
  if(state.status==='protocol-unavailable')return 'HTTP通道已开启，协议未通过；保留错误，不启动第二实例。';
  if(!state.processCheck.checked||state.status==='permission-blocked')return '当前执行环境无法核对进程或访问通道。停止启动；使用真正获准运行桌面程序的系统执行通道，不能仅设置提权字段后继续。';
  if(state.processes.length)return '开发者工具主进程仍在运行，禁止启动第二实例。';
  if(state.status!=='not-listening')return '通道状态不明确，停止启动并保留原始错误。';
  if(!authorized)return '尚未确认启动授权；取得用户许可后才能启动。';
  return null;
}

/** 唯一准备流程：先检查，许可和执行条件齐备后正常退出一次、启动一次。 */
export async function prepareDebugChannel({port,project,authorized=false,check=inspectDebugChannel,quit,launch,readLog=()=>'',now=Date.now,pause=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const inspect=()=>check({port,project});
  let state=await inspect();
  const result=(status,reason,extra={})=>({status,reason,check:state,...extra});
  const failed=(status,e)=>result(status,e.message,{error:Object.fromEntries(['message','code','exitCode','signal','stdout','stderr','output'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]]))});
  if(state.status==='ready')return result(project&&state.projectMatches!==1?'project-unresolved':'ready',state.advice);
  if(state.status==='protocol-unavailable')return result('protocol-unavailable',state.advice);
  if(!state.processCheck.checked||state.status==='permission-blocked')return result('execution-blocked',launchBlockReason(state,authorized));
  if(state.processes.some(p=>p.debugPort!==null)||state.status!=='not-listening')return result('inspection-required',state.advice);
  if(!authorized)return result('authorization-required','需正常退出并带调试参数启动一次；先取得用户许可。');
  if(state.processes.length>1)return result('inspection-required','主进程不唯一，不能猜测退出目标。');
  if(!launch||state.processes.length&&!quit)return result('configuration-required','授权启动还需要已确认的程序、官方CLI和新日志路径。');
  if(state.processes.length){
    const original=state.processes[0];
    try{await quit(original)}catch(e){return failed('quit-failed',e)}
    const deadline=now()+15000;
    do{
      state=await inspect();
      if(!state.processCheck.checked)return result('execution-blocked','退出后的进程状态无法核对；不继续启动。');
      if(!state.processes.length)break;
      if(now()>=deadline)return result('exit-unconfirmed','正常退出未完成；不强杀、不启动第二实例。');
      await pause(500);
    }while(true);
  }
  const blocked=launchBlockReason(state,true);
  if(blocked)return result('launch-blocked',blocked);
  let started;
  try{started=await launch()}catch(e){return failed('startup-failed',e)}
  const deadline=now()+30000;
  do{
    state=await inspect();
    const text=readLog();
    if(/sandbox initialization failed|Failed to initialize sandbox|SingletonLock[^\n]*(?:Operation not permitted|File exists)|bad option/i.test(text))return result('startup-failed','启动日志确认运行环境拒绝GUI或存在实例冲突；停止，不调用CLI重新拉起，不再次重启。',{started});
    if(state.status==='ready')return result(project&&state.projectMatches!==1?'project-unresolved':'ready',state.advice,{started});
    if(state.status==='protocol-unavailable')return result('protocol-unavailable',state.advice,{started});
    if(!state.processCheck.checked||state.status==='permission-blocked')return result('execution-blocked','启动后的检查受到权限限制；停止重复尝试。',{started});
    if(now()>=deadline)return result('startup-failed','30秒内未取得真实HTTP目标列表；保留启动日志，不重复启动。',{started});
    await pause(500);
  }while(true);
}
