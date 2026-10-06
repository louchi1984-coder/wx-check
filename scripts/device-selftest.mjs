#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {findProjectDeviceFile,patchDevice,createDeviceSession,waitDeviceReady} from './lib/device-patch.mjs';
function fixture() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ui-device-test-'));
 const project=path.join(root,'project'), other=path.join(root,'other');fs.mkdirSync(project);fs.mkdirSync(other);
 fs.writeFileSync(path.join(project,'app.json'),JSON.stringify({pages:['home'],tabBar:{list:[{pagePath:'home'}]}}));
 const dir=path.join(root,'data','profile','WeappLocalData');fs.mkdirSync(dir,{recursive:true});
 const a='a'.repeat(32),b='b'.repeat(32);
 fs.writeFileSync(path.join(dir,'hash_key_map_2.json'),JSON.stringify({[a]:'toolbar_'+project,[b]:'toolbar_'+other}));
 const list=[{name:'A',desc:'320 x 568',info:{model:'A',screenWidth:320,screenHeight:568,dpr:2}},
 {name:'B',desc:'390 x 844',info:{model:'B',screenWidth:390,screenHeight:844,dpr:3}}];
 const data={device:{current:0,list},deviceInfo:list[0].info,network:'preserve'};
 const file=path.join(dir,'localstorage_'+a+'.json'),otherFile=path.join(dir,'localstorage_'+b+'.json');
 fs.writeFileSync(file,JSON.stringify(data));fs.writeFileSync(otherFile,JSON.stringify(data));
 let route='home',openCount=0;
 const calls=[];
 const call=(tool,args)=>{
  calls.push(tool);
  if(tool==='open_project_window')openCount++;
  if(tool==='automation_navigate')route=args[args.indexOf('--url')+1].slice(1);
  if(tool!=='automation_evaluate')return {ok:true,result:{success:true}};
  const fn=args[args.indexOf('--fn-source')+1];
  const d=JSON.parse(fs.readFileSync(file));const info=d.deviceInfo;
  const value=fn.includes('getWindowInfo')?{window:{screenWidth:info.screenWidth,screenHeight:info.screenHeight,pixelRatio:info.dpr,windowWidth:info.screenWidth,windowHeight:500},device:{model:info.model},route}:route;
  return {ok:true,result:{success:true,result:{result:value}}};
 };
 return {root:path.join(root,'data'),project,file,otherFile,list,call,calls,backupDir:path.join(root,'backup')};
}
let passed=0;function test(name,fn){fn();passed++;console.log('✓ '+name);}
test('按精确项目映射写一个文件，其余项目逐字节不变',()=>{
 const f=fixture(),before=fs.readFileSync(f.otherFile,'utf8');
 assert.equal(findProjectDeviceFile(f.project,f.root),f.file);
 const hit=patchDevice('B',f);assert.equal(hit.patched,1);assert.equal(JSON.parse(fs.readFileSync(f.file)).device.current,1);assert.equal(fs.readFileSync(f.otherFile,'utf8'),before);
});
test('禁止旧的全项目写入签名',()=>assert.throws(()=>patchDevice('B'),/必须指定 project/));
test('映射缺失时不写其他项目',()=>{const f=fixture(),before=fs.readFileSync(f.otherFile,'utf8');assert.throws(()=>patchDevice('B',{...f,project:f.project+'wrong'}),/唯一定位/);assert.equal(fs.readFileSync(f.otherFile,'utf8'),before);});
test('同项目映射多目录时拒绝猜测',()=>{const f=fixture();const dir=path.join(f.root,'another','WeappLocalData');fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(path.join(path.dirname(f.file),'hash_key_map_2.json'),path.join(dir,'hash_key_map_2.json'));fs.copyFileSync(f.file,path.join(dir,path.basename(f.file)));assert.throws(()=>findProjectDeviceFile(f.project,f.root),/2 个/);});
test('切换后两次真实尺寸稳定，再检测；finally恢复原机型和页面',()=>{
 const f=fixture(),before=fs.readFileSync(f.otherFile,'utf8');const session=createDeviceSession(f.project,f);
 try{const hit=session.switchTo('B');assert.equal(hit.runtime.window.screenWidth,390);assert.equal(hit.readiness.length,2);assert(fs.existsSync(session.backupFile));const d=JSON.parse(fs.readFileSync(f.file));d.network='changed';fs.writeFileSync(f.file,JSON.stringify(d));}
 finally{const restored=session.restore();assert(restored.restored);assert.equal(restored.page,'home');}
 const d=JSON.parse(fs.readFileSync(f.file));assert.equal(d.device.current,0);assert.deepEqual(d.deviceInfo,f.list[0].info);assert.equal(d.network,'changed');assert.equal(fs.readFileSync(f.otherFile,'utf8'),before);
});
test('业务检测抛异常仍能恢复，而不是只在成功时恢复',()=>{const f=fixture(),session=createDeviceSession(f.project,f);assert.throws(()=>{try{session.switchTo('B');throw new Error('UI failed');}finally{assert(session.restore().restored);}},/UI failed/);assert.equal(JSON.parse(fs.readFileSync(f.file)).device.current,0);});
test('就绪探测有限次数，旧尺寸不当成新机型',()=>{let calls=0;const f=fixture();const call=(...args)=>{calls++;return f.call(...args)};assert.throws(()=>waitDeviceReady(f.project,f.list[1],{call}),/四次/);assert.equal(calls,4);});
test('保存备份在工程外且不覆盖既有恢复副本',()=>{const f=fixture();assert.throws(()=>createDeviceSession(f.project,{...f,backupDir:path.join(f.project,'backup')}),/工程外/);fs.mkdirSync(f.backupDir);fs.writeFileSync(path.join(f.backupDir,'device-backup.json'),'keep');const session=createDeviceSession(f.project,f);try{assert.throws(()=>session.switchTo('B'),/已有机型备份/);}finally{session.restore();}assert.equal(fs.readFileSync(path.join(f.backupDir,'device-backup.json'),'utf8'),'keep');});
console.log(passed+' 项机型切换回归通过');
