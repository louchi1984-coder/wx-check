import http from 'node:http';

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
