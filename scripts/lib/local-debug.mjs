import http from 'node:http';

/** 同一调用过程复用CDP连接；只接受本机目标，关闭时终止未完成请求。 */
export async function connectLocalTarget(target, port, timeout = 5000) {
  const url = new URL(target.webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port) throw Error('拒绝非预期本机调试地址');
  const ws = new WebSocket(url.href), pending = new Map(); let id = 0;
  const rejectPending = error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  ws.addEventListener('message', event => {
    let data;
    try { data = JSON.parse(event.data); } catch { rejectPending(Error('调试协议返回格式异常')); return; }
    const entry = pending.get(data.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(data.id);
    data.error ? entry.reject(Error(data.error.message)) : entry.resolve(data.result);
  });
  ws.addEventListener('close', () => rejectPending(Error('项目调试连接已关闭')));
  ws.addEventListener('error', () => rejectPending(Error('项目调试连接失败')));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Error('项目调试连接超时')); }, timeout);
    ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('项目调试连接失败')); }, { once: true });
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  return { close: () => ws.close(), async evaluate(expression, limit = 15000) {
    const requestId = ++id;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(Error('窗口脚本调用超时')); }, limit);
      pending.set(requestId, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); }
      catch (e) { clearTimeout(timer); pending.delete(requestId); reject(e); }
    });
    if (result?.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    if (!result?.result) throw Error('调试协议缺少执行结果');
    return result.result.value;
  } };
}

/** 直接连接回环地址，不使用fetch的全局代理调度器。 */
export function readLocalTargets(port, timeout = 5000) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('调试端口无效');
  return new Promise((resolve,reject) => {
    const request = http.get({hostname:'127.0.0.1',port,path:'/json/list'},response => {
      let text='';response.setEncoding('utf8');
      response.on('data',chunk=>{text+=chunk});
      response.on('error',e=>{clearTimeout(timer);reject(e)});
      response.on('end',()=>{
        clearTimeout(timer);
        try {
          if(response.statusCode !== 200) throw Error('HTTP '+response.statusCode);
          const targets=JSON.parse(text);if(!Array.isArray(targets)) throw Error('调试目标返回格式异常');
          resolve(targets);
        } catch(e) { reject(e); }
      });
    });
    const timer=setTimeout(()=>request.destroy(Error('本机调试连接超时')),timeout);
    request.on('error',e=>{clearTimeout(timer);reject(e)});
  });
}
