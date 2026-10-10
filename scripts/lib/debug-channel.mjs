import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readLocalTargets, connectLocalTarget } from './local-debug.mjs';

export function resolveDebugPort(explicit, env=process.env) {
  const port=Number(explicit ?? env.WECHATIDE_DEBUG_PORT ?? 9223);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('调试端口无效');
  return port;
}

/** GUI子进程不能继承Electron的Node运行模式；其他环境和安全钩子原样保留。 */
export function debugLaunchCommand(executable, port, env=process.env) {
  const childEnv={...env};
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return {executable,args:['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+resolveDebugPort(port,env)],env:childEnv};
}

export function parseMacProcesses(stdout) {
  const processes=[];
  for(const line of stdout.split('\n')){
    const match=line.match(/^\s*(\d+)\s+(\/.+?\.app\/Contents\/MacOS\/\S+)(?:\s+(.*))?$/);
    // argv里提到程序路径的node/启动命令不是开发者工具主进程。
    if(!match||!/wechatwebdevtools/i.test(match[2])||/\s--|\s\S+\.(?:mjs|cjs|js)(?:\s|$)/.test(match[2])||match[2].includes('/Contents/Frameworks/')||/--type=|skill-index\.js|(?:^|\s)-e(?:\s|$)/.test(match[3]||''))continue;
    const flag=(match[3]||'').match(/--remote-debugging-port(?:=|\s+)(\d+)/);
    processes.push({pid:Number(match[1]),executable:match[2],debugPort:flag?Number(flag[1]):null});
  }
  return processes;
}

export function readProcessInfo() {
  if(process.platform==='win32'){
    const script="[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^(wechat(web)?devtools|微信开发者工具)\\.exe$' -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
    const r=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:3000});
    if(r.error||r.status!==0)return {checked:false,error:r.error?.message||r.stderr.trim()||'进程读取失败'};
    try{
      const data=r.stdout.trim()?JSON.parse(r.stdout):[];
      const rows=Array.isArray(data)?data:[data];
      if(rows.some(p=>!p.ExecutablePath||!p.CommandLine))return {checked:false,error:'进程参数读取不完整'};
      return {checked:true,processes:rows.map(p=>({pid:Number(p.ProcessId),executable:p.ExecutablePath,debugPort:Number(p.CommandLine.match(/--remote-debugging-port(?:=|\s+)(\d+)/)?.[1])||null}))};
    }catch(e){return {checked:false,error:'进程读取格式异常：'+e.message}}
  }
  if(process.platform!=='darwin')return {checked:false,error:'此平台需由执行者核对开发者工具主进程参数'};
  const r=spawnSync('/bin/ps',['-axo','pid=,args='],{encoding:'utf8',timeout:3000});
  if(r.error||r.status!==0)return {checked:false,error:r.error?.message||r.stderr.trim()||'进程读取失败'};
  return {checked:true,processes:parseMacProcesses(r.stdout)};
}

/** 实际发出只读协议命令，核对窗口工程；HTTP可连接不等于协议可用。 */
export async function probeDebugTarget(target,{port,project,timeout=3000}) {
  const client=await connectLocalTarget(target,port,timeout);
  try{
    const actual=new URL(await client.evaluate('location.href',timeout));
    if(!/\/electron-project(?:-lite)?\.html$/.test(actual.pathname)||path.resolve(actual.searchParams.get('projectpath')||'')!==path.resolve(project))throw Error('协议返回的工程窗口与目标不一致');
    return {available:true,method:'Runtime.evaluate',projectVerified:true};
  }finally{client.close()}
}

/** 先检查并复用通道，只有HTTP连接失败才核对进程；不登录、退出或启动。 */
export async function inspectDebugChannel({port,project,read=readLocalTargets,probe=probeDebugTarget,processInfo=readProcessInfo,env=process.env}={}) {
  port=resolveDebugPort(port,env);
  let connected=false;
  const result={time:new Date().toISOString(),project:project?path.resolve(project):null,port,environment:{electronNodeModeVariableSet:Boolean(env.ELECTRON_RUN_AS_NODE)},processCheck:{checked:false,skipped:true},processes:[]};
  try{
    const targets=await read(port,3000);
    connected=true;
    result.status='ready';result.targetCount=targets.length;
    const matching=targets.filter(t=>{
      try{const u=new URL(t.url);return t.type==='page'&&/\/electron-project(?:-lite)?\.html$/.test(u.pathname)&&path.resolve(u.searchParams.get('projectpath')||'')===path.resolve(project)}catch{return false}
    });
    if(project)result.projectMatches=matching.length;
    if(project&&matching.length===1)result.protocol=await probe(matching[0],{port,project});
    else result.protocol={available:false,reason:'未唯一指定工程窗口，仅检查HTTP通道'};
    result.advice=project&&result.projectMatches!==1?'调试通道可连接，但目标工程窗口无法唯一确定；核对工程路径，不重启。':'调试通道可连接，复用现有进程。';
  }catch(e){
    result.error={code:e.code||null,message:e.message};
    if(connected){result.status='protocol-unavailable';result.protocol={available:false,reason:e.message};result.advice='HTTP通道仍可连接，但目标窗口协议未通过。保留错误，核对窗口状态，不因本次协议失败重启或改端口。';return result}
    const info=processInfo();
    result.processCheck={checked:info.checked,error:info.error};result.processes=info.processes||[];
    result.status=['EPERM','EACCES'].includes(e.code)?'permission-blocked':e.code==='ECONNREFUSED'?'not-listening':'unreachable';
    const other=result.processes.map(p=>p.debugPort).filter(p=>p&&p!==port);
    result.advice=other.length?'进程实际调试端口为 '+[...new Set(other)].join('、')+'；核对并统一检测参数，不换端口重启。'
      :!info.checked||result.status==='permission-blocked'?'检查受到权限限制或进程状态无法核实；使用当前agent的权限申请流程，不把读取失败当成进程已退出，不继续重复启动。'
      :result.processes.length&&result.processes.every(p=>p.debugPort===null)?'运行中的主进程没有调试参数；继续等待不会开启端口。按debug-channel.md准备，启动前须取得重启授权。'
      :'通道未连接；按debug-channel.md核对主进程、启动日志和本机访问权限，不盲目重启。';
    if(result.environment.electronNodeModeVariableSet)result.advice+=' 当前环境设置了ELECTRON_RUN_AS_NODE；GUI启动子进程须仅移除该变量，否则Electron可能按Node解析调试参数。';
  }
  return result;
}
