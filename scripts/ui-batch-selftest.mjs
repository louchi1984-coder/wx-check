#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { scanUI, checkPage } from './lib/ui-scan.mjs';
import { mergeIssues, buildPlan } from './ui-check.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-batch-test-'));
fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify({pages:['one','two']}));
for (const p of ['one','two']) fs.writeFileSync(path.join(root,p+'.wxml'), '<view class="page"><view class="btn" bindtap="save">保存</view></view>');
const win = {windowWidth:320,windowHeight:456,screenWidth:320,screenHeight:568,pixelRatio:2};
function mock(options={}) {
  const calls=[]; let route='one', snapshots=0;
  const call=(tool,args) => {
    calls.push({tool,args});
    if (options.timeout) throw new Error('timeout waiting for automator response');
    if (tool==='automation_navigate') { route=args[args.indexOf('--url')+1].slice(1); return {ok:true,result:{success:true}}; }
    if (tool==='simulator_screenshot') return {ok:true,result:{success:true}};
    if (tool==='automation_runtime_info') return {ok:true,result:{success:true,currentPage:{pageId:options.stalePage?2:1,path:route}}};
    const fn=args[args.indexOf('--fn-source')+1];
    let data;
    if (!fn.includes('createSelectorQuery')) data={window:options.window || win,device:{model:'mock'},route:options.startRoute};
    else {
      snapshots++;
      const left=options.unstable?snapshots:options.animation?Math.min(snapshots,3):0;
      data={route:options.wrongRoute?'other':route,nativeId:1,window:options.pageHeight && route==='two'?{...win,windowHeight:480}:win,rects:options.missing?[[]]:[
        [{left,top:0,right:320,bottom:100,width:320,height:100}],
        [{left:10,top:10,right:options.overflow?350:100,bottom:60,width:90,height:50}]]};
    }
    return {ok:true,result:{success:true,result:{result:data}}};
  };
  return {call,calls};
}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('✓ '+name);}
const opts={expectedSize:{width:320,height:568}};
await test('最小检查每页一次采集，不编译、刷新或正常截图',async()=>{
 const m=mock();const r=await scanUI(root,{...opts,...m});
 assert.equal(r.pages.length,2);assert.equal(r.elements,4);assert.equal(m.calls.length,8);
 assert(m.calls.every(c=>['automation_evaluate','automation_navigate','automation_runtime_info'].includes(c.tool)));
});
await test('新机型精测按完整名称匹配，同尺寸旧型号降为最小检查',async()=>{
  const names=['Small A','Small B','Medium A','Medium B','Large A','Wide B'];
  const previous=process.env.WECHATIDE_PRECISE_MODELS;
  process.env.WECHATIDE_PRECISE_MODELS=JSON.stringify(names);
  try {
  const table=['iPhone 14 Pro Max',...names].map((name,index)=>({name,index,type:'default',desc:'430 x 932 | Dpr:3'}));
  const plan=buildPlan(table);
  assert.equal(plan[0].mode,'minimal');
  assert.equal(plan.filter(x=>x.mode==='precise').length,6);
  for(const group of ['小','中','大'])assert.equal(plan.filter(x=>x.group===group).length,2);
  assert.throws(()=>buildPlan(table.slice(0,-1)),/缺少精测机型/);
  } finally { if(previous===undefined)delete process.env.WECHATIDE_PRECISE_MODELS;else process.env.WECHATIDE_PRECISE_MODELS=previous; }
});
await test('精测核对稳定性并且每页只保留一张截图',async()=>{const m=mock();const r=await scanUI(root,{...opts,...m,mode:'precise'});assert.equal(r.pages.length,2);assert.equal(m.calls.length,16);assert.equal(m.calls.filter(c=>c.tool==='simulator_screenshot').length,2);assert(r.pages.every(p=>p.screenshot));});
await test('不同页面内容高度变化不误判为机型切换',async()=>{const m=mock({pageHeight:true});const r=await scanUI(root,{...opts,...m,mode:'precise'});assert(!r.incomplete);assert.equal(r.pages[1].viewport.height,480);});
await test('已在原页面时不重复导航恢复',async()=>{const m=mock({startRoute:'two'});const r=await scanUI(root,{...opts,...m});assert(r.restored);assert.equal(m.calls.length,8);});
await test('尺寸不匹配时不导航、不套默认尺寸',async()=>{const m=mock({window:{...win,screenWidth:390}});await assert.rejects(()=>scanUI(root,{...opts,...m}),/目标尺寸/);assert.equal(m.calls.length,1);});
await test('automator持续超时只恢复一次，随后停止',async()=>{const m=mock({timeout:true});const waits=[];await assert.rejects(()=>scanUI(root,{...opts,...m,sleep:async ms=>waits.push(ms)}),/timeout/);assert.equal(m.calls.length,2);assert.deepEqual(waits,[]);});
await test('IDE返回超时后重试成功，后续正常采集',async()=>{const m=mock();let attempts=0;const waits=[];const call=(...args)=>++attempts===1?{ok:false,message:'timeout waiting for automator response'}:m.call(...args);const r=await scanUI(root,{...opts,call,sleep:async ms=>waits.push(ms)});assert.equal(r.elements,4);assert.deepEqual(waits,[]);});
await test('一般错误不等待不重试',async()=>{let calls=0;const waits=[];await assert.rejects(()=>scanUI(root,{...opts,call:()=>{calls++;throw new Error('permission denied');},sleep:async ms=>waits.push(ms)}),/permission denied/);assert.equal(calls,1);assert.equal(waits.length,0);});
await test('恢复成功后再次超时不重复恢复',async()=>{let calls=0;const waits=[];const m=mock();const call=(...args)=>{calls++;if(calls===1||calls===4)throw new Error('timeout waiting for automator response');return m.call(...args);};await assert.rejects(()=>scanUI(root,{...opts,call,sleep:async ms=>waits.push(ms)}),/timeout/);assert.equal(calls,4);assert.deepEqual(waits,[]);});
await test('错误页面不记为通过，仍核对其他页面',async()=>{const m=mock({wrongRoute:true});const r=await scanUI(root,{...opts,...m});assert(r.incomplete);assert.equal(r.elements,0);assert.deepEqual(r.unvisitedPages,[]);assert.equal(r.pages.length,2);});
await test('同路径旧页面编号停止采集，不能生成该页截图证据',async()=>{const m=mock({stalePage:true});const r=await scanUI(root,{...opts,...m,mode:'precise'});assert(r.incomplete);assert.equal(r.elements,0);assert.match(r.pages[0].error,/已过期/);assert.equal(m.calls.filter(c=>c.tool==='simulator_screenshot').length,0);});
await test('页面编号查询失败停止采集，不只比较路径',async()=>{const m=mock();const call=(tool,...args)=>tool==='automation_runtime_info'?{ok:false,message:'unavailable'}:m.call(tool,...args);const r=await scanUI(root,{...opts,call});assert(r.incomplete);assert.equal(r.elements,0);assert.deepEqual(r.unvisitedPages,[]);assert.equal(r.pages.length,2);});
await test('丢失采集结果不记为零问题通过',async()=>{const m=mock({missing:true});const r=await scanUI(root,{...opts,...m});assert(r.incomplete);assert.equal(r.elements,0);});
await test('精测动画或持续变化保留截图并标记读图判断，不中止后续页面',async()=>{const m=mock({unstable:true});const waits=[];const r=await scanUI(root,{...opts,...m,mode:'precise',sleep:async ms=>waits.push(ms)});assert.equal(r.pages.length,2);assert(r.pages.every(p=>p.layoutStable===false&&p.needsVisualReview));assert.deepEqual(waits,[100,100]);assert.equal(m.calls.filter(c=>c.tool==='simulator_screenshot').length,2);});
await test('页面无class可见元素仍采集截图，几何缺口不判为通过',async()=>{const m=mock();const call=(tool,args,...rest)=>{const r=m.call(tool,args,...rest);if(tool==='automation_evaluate'&&args[args.indexOf('--fn-source')+1].includes('createSelectorQuery'))r.result.result.result.rects=[[],[]];return r;};const r=await scanUI(root,{...opts,call,mode:'precise'});assert(r.incomplete);assert.equal(r.elements,0);assert(r.pages.every(p=>p.needsVisualReview&&p.screenshot));});
await test('异常才截图，且截图在工程外',async()=>{const m=mock({overflow:true});const r=await scanUI(root,{...opts,...m});assert(r.totals.P0>0);assert.equal(m.calls.filter(c=>c.tool==='simulator_screenshot').length,2);assert(r.pages.every(p=>!p.screenshot.startsWith(root+path.sep)));});
const rail={left:0,top:0,right:320,bottom:50,width:320,height:50,scrollX:true};
const chip={left:300,top:10,right:380,bottom:40,width:80,height:30};
const clip={containers:[rail],descendants:[chip]};
await test('横向滚动容器裁剪的内容不误报屏幕溢出',async()=>{assert.equal(checkPage({rail:[rail],chip:[chip]},[],320,[clip]).issues.length,0);});
await test('关闭横向滚动后仍检测真实溢出',async()=>{assert.equal(checkPage({chip:[chip]},[],320,[{...clip,containers:[{...rail,scrollX:false}]}]).issues.length,1);});
await test('滚动容器自身越界不能豁免其内容',async()=>{const wide={...rail,right:350,width:350};const r=checkPage({rail:[wide],chip:[chip]},[],320,[{...clip,containers:[wide]}]);assert.equal(r.issues.length,2);});
await test('同类名但在滚动容器外的元素仍检测溢出',async()=>{const outside={...chip,top:70,bottom:100};const r=checkPage({chip:[chip,outside]},[],320,[clip]);assert.equal(r.issues.length,1);});
await test('运行时滚动属性与后代在同次采集读取，最小检查不产生误报截图',async()=>{
 const file=path.join(root,'one.wxml'),before=fs.readFileSync(file);
 fs.writeFileSync(file,'<scroll-view id="rail" class="rail r-{{state}}" scroll-x="{{enabled}}"><view class="chip" /></scroll-view>');
 const calls=[];let route='';
 const call=async(tool,args)=>{
  calls.push(tool);
  if(tool==='automation_navigate'){route='one';return {ok:true,result:{success:true}};}
  if(tool==='automation_runtime_info')return {ok:true,result:{success:true,currentPage:{pageId:1,path:route}}};
  const requests=[];let selector;
  const query={in(){return this;},selectAll(s){selector=s;return this;},boundingClientRect(){requests.push(selector==='.rail'?[rail]:selector==='.chip'||selector.includes(' .chip')?[chip]:[]);return this;},fields(fields){assert.deepEqual(Array.from(fields.properties),['scrollX']);requests.push([rail]);return this;},exec(cb){cb(requests);}};
  const fn=vm.runInNewContext('('+args[args.indexOf('--fn-source')+1]+')',{getCurrentPages:()=>[{route,__wxWebviewId__:1}],wx:{createSelectorQuery:()=>query,getWindowInfo:()=>win,getDeviceInfo:()=>({model:'test'})}});
  return {ok:true,result:{success:true,result:{result:await fn()}}};
 };
 try {const r=await scanUI(root,{...opts,call,only:'one'});assert(!r.incomplete);assert.equal(r.totals.P0,0);assert.equal(r.pages[0].scrollClips.length,1);assert(!calls.includes('simulator_screenshot'));assert.equal(calls.length,5);}
 finally{fs.writeFileSync(file,before);}
});
await test('禁止将截图写入工程中',async()=>{const m=mock();await assert.rejects(()=>scanUI(root,{...opts,...m,screenshotDir:path.join(root,'shots')}),/工程之外/);});
await test('同一问题跨机型合并且保留机型清单',async()=>{
 const issue={rule:'横向溢出',class:'btn page',level:'P0'};
 const r={screen:{width:320,height:568},device:{model:'A'},issues:[],pages:[{page:'one',issues:[issue]}]};
 const merged=mergeIssues([r,{...r,device:{model:'B'}}]);assert.equal(merged.length,1);assert.equal(merged[0].devices.length,2);
});
await test('一个页面调用失败仍执行后页，真实CDP断开则保留未执行页',async()=>{
 const m=mock();const call=(tool,args,...rest)=>tool==='automation_navigate'&&args.includes('/one')?{ok:false,message:'one page unavailable'}:m.call(tool,args,...rest);
 const r=await scanUI(root,{...opts,call});assert.equal(r.pages.length,2);assert(r.pages[0].error);assert.equal(r.pages[1].elements,2);assert(!r.aborted);
 const m2=mock();const broken=(tool,...args)=>{if(tool==='automation_navigate')throw Error('项目调试连接已关闭');return m2.call(tool,...args)};
 const stopped=await scanUI(root,{...opts,call:broken});assert(stopped.aborted);assert.deepEqual(stopped.unvisitedPages,['two']);
});
console.log(passed+' 项批量 UI 回归通过');
