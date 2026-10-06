#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLiveDeviceSession } from './lib/device-live.mjs';
function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-device-test-'));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'app.json'), JSON.stringify({ pages:['home','other'], tabBar:{list:[{pagePath:'home'}]} }));
  const list = ['A','B'].map((name,index)=>({name,info:{model:name,screenWidth:320+70*index,screenHeight:568+276*index,dpr:2+index}}));
  const state = { current:0, list, route:'home', network:'preserve', selected:[], calls:[], closed:0 };
  const transport = { close(){state.closed++;}, async evaluate(expression) {
    state.calls.push(expression);
    if(options.wrongProject)throw Error('目标项目已改变');
    const selected = /selectDevice\((\d+)\)/.exec(expression);
    if(selected){ state.current=Number(selected[1]);state.selected.push(state.current);return true; }
    const raw = /bridge.request\((\{.*\}),\d+\)/s.exec(expression);
    if(!raw)return {current:state.current,list:structuredClone(list)};
    const message=JSON.parse(raw[1]); let result;
    if(message.method==='App.callFunction'){
      const info=list[options.stale?0:state.current].info;
      result={result:{window:{screenWidth:info.screenWidth,screenHeight:info.screenHeight,pixelRatio:info.dpr,windowWidth:info.screenWidth,windowHeight:500},device:{model:info.model},route:state.route}};
    }else if(message.method==='App.callWxMethod'){state.route=message.params.args[0].url.slice(1);result={};}
    else throw Error('unexpected method');
    return JSON.stringify({id:message.id,result});
  } };
  return { project, backupDir:path.join(root,'backup'), transport, state };
}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('✓ '+name);}
await test('连续切换复用连接，只调用机型动作；恢复原机型与页面',async()=>{
  const f=fixture(),s=await createLiveDeviceSession(f.project,f);
  try{
    const b=await s.switchTo('B');assert.equal(b.runtime.device.model,'B');assert.equal(b.readiness.length,2);
    await s.call('automation_navigate',['--action','reLaunch','--url','/other']);
    assert((await s.restore()).restored);assert.equal(f.state.route,'home');assert.equal(f.state.current,0);
    assert.equal(f.state.network,'preserve');assert(f.state.calls.every(x=>!x.includes('close_project_window')&&!x.includes('open_project_window')));
  }finally{s.close();}
  assert.equal(f.state.closed,1);
});
await test('采集抛错也在 finally 恢复，不能只恢复配置',async()=>{
  const f=fixture(),s=await createLiveDeviceSession(f.project,f);
  await assert.rejects(async()=>{try{await s.switchTo('B');throw Error('采集失败');}finally{assert((await s.restore()).restored);s.close();}},/采集失败/);
  assert.equal(f.state.current,0);assert.deepEqual(f.state.selected,[1,0]);
});
await test('旧运行尺寸不算切换成功；探测有上限且失败后仍恢复',async()=>{
  const f=fixture({stale:true}),s=await createLiveDeviceSession(f.project,f);
  try{await assert.rejects(()=>s.switchTo('B'),e=>e.attempts.length>=10);assert((await s.restore()).restored);assert.equal(f.state.current,0);}finally{s.close();}
});
await test('目标路径改变时停止，并关闭连接，不生成成功备份',async()=>{
  const f=fixture({wrongProject:true});await assert.rejects(()=>createLiveDeviceSession(f.project,f),/目标项目已改变/);
  assert.equal(f.state.closed,1);assert(!fs.existsSync(path.join(f.backupDir,'device-backup.json')));
});
await test('已有恢复备份不可覆盖，工程内不可写备份',async()=>{
  const f=fixture();fs.mkdirSync(f.backupDir);const file=path.join(f.backupDir,'device-backup.json');fs.writeFileSync(file,'keep');
  await assert.rejects(()=>createLiveDeviceSession(f.project,f),/已有机型备份/);assert.equal(fs.readFileSync(file,'utf8'),'keep');
  await assert.rejects(()=>createLiveDeviceSession(f.project,{...f,backupDir:f.project}),/工程之外/);
});
await test('不存在的机型不切换；当前机型不重复触发切换动作',async()=>{
  const f=fixture(),s=await createLiveDeviceSession(f.project,f);
  try{await assert.rejects(()=>s.switchTo('missing'),/没有机型/);await s.switchTo('A');assert.deepEqual(f.state.selected,[]);assert((await s.restore()).restored);}finally{s.close();}
});
console.log(passed+' 项运行中切换回归通过');
