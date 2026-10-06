#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanUI } from './lib/ui-scan.mjs';
import { mergeIssues, buildPlan } from './ui-check.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-batch-test-'));
fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify({pages:['one','two']}));
for (const p of ['one','two']) fs.writeFileSync(path.join(root,p+'.wxml'), '<view class="page"><view class="btn" bindtap="save">保存</view></view>');
const win = {windowWidth:320,windowHeight:456,screenWidth:320,screenHeight:568,pixelRatio:2};
function mock(options={}) {
  const calls=[]; let route='', snapshots=0;
  const call=(tool,args) => {
    calls.push({tool,args});
    if (options.timeout) throw new Error('timeout waiting for automator response');
    if (tool==='automation_navigate') { route=args[args.indexOf('--url')+1].slice(1); return {ok:true,result:{success:true}}; }
    if (tool==='simulator_screenshot') return {ok:true,result:{success:true}};
    const fn=args[args.indexOf('--fn-source')+1];
    let data;
    if (!fn.includes('createSelectorQuery')) data={window:options.window || win,device:{model:'mock'},route:options.startRoute};
    else {
      snapshots++;
      const left=options.unstable?snapshots:0;
      data={route:options.wrongRoute?'other':route,window:options.pageHeight && route==='two'?{...win,windowHeight:480}:win,rects:options.missing?[[]]:[
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
 assert.equal(r.pages.length,2);assert.equal(r.elements,4);assert.equal(m.calls.length,6);
 assert(m.calls.every(c=>['automation_evaluate','automation_navigate'].includes(c.tool)));
});
await test('新机型精测按完整名称匹配，同尺寸旧型号降为最小检查',async()=>{
  const names=['HUAWEI Mate X6外','HUAWEI nova 14 Ultra','HUAWEI Mate 80','HUAWEI Mate 70 Pro','iPhone 15 Pro Max','HUAWEI Pura X Max内'];
  const table=['iPhone 14 Pro Max',...names].map((name,index)=>({name,index,type:'default',desc:'430 x 932 | Dpr:3'}));
  const plan=buildPlan(table);
  assert.equal(plan[0].mode,'minimal');
  assert.equal(plan.filter(x=>x.mode==='precise').length,6);
  for(const group of ['小','中','大'])assert.equal(plan.filter(x=>x.group===group).length,2);
  assert.throws(()=>buildPlan(table.slice(0,-1)),/缺少精测机型/);
});
await test('精测核对稳定性并且每页只保留一张截图',async()=>{const m=mock();const r=await scanUI(root,{...opts,...m,mode:'precise'});assert.equal(r.pages.length,2);assert.equal(m.calls.length,10);assert.equal(m.calls.filter(c=>c.tool==='simulator_screenshot').length,2);assert(r.pages.every(p=>p.screenshot));});
await test('不同页面内容高度变化不误判为机型切换',async()=>{const m=mock({pageHeight:true});const r=await scanUI(root,{...opts,...m,mode:'precise'});assert(!r.incomplete);assert.equal(r.pages[1].viewport.height,480);});
await test('已在原页面时不重复导航恢复',async()=>{const m=mock({startRoute:'two'});const r=await scanUI(root,{...opts,...m});assert(r.restored);assert.equal(m.calls.length,6);});
await test('尺寸不匹配时不导航、不套默认尺寸',async()=>{const m=mock({window:{...win,screenWidth:390}});await assert.rejects(()=>scanUI(root,{...opts,...m}),/目标尺寸/);assert.equal(m.calls.length,1);});
await test('超时立即停止，不对每个class重试',async()=>{const m=mock({timeout:true});await assert.rejects(()=>scanUI(root,{...opts,...m}),/timeout/);assert.equal(m.calls.length,1);});
await test('错误页面不记为通过，并停止后续页面',async()=>{const m=mock({wrongRoute:true});const r=await scanUI(root,{...opts,...m});assert(r.incomplete);assert.equal(r.elements,0);assert.deepEqual(r.unvisitedPages,['two']);});
await test('丢失采集结果不记为零问题通过',async()=>{const m=mock({missing:true});const r=await scanUI(root,{...opts,...m});assert(r.incomplete);assert.equal(r.elements,0);});
await test('精测布局不稳定时不给通过结论',async()=>{const m=mock({unstable:true});const r=await scanUI(root,{...opts,...m,mode:'precise'});assert(r.incomplete);assert.match(r.pages[0].error,/不稳定/);});
await test('异常才截图，且截图在工程外',async()=>{const m=mock({overflow:true});const r=await scanUI(root,{...opts,...m});assert(r.totals.P0>0);assert.equal(m.calls.filter(c=>c.tool==='simulator_screenshot').length,2);assert(r.pages.every(p=>!p.screenshot.startsWith(root+path.sep)));});
await test('禁止将截图写入工程中',async()=>{const m=mock();await assert.rejects(()=>scanUI(root,{...opts,...m,screenshotDir:path.join(root,'shots')}),/工程之外/);});
await test('同一问题跨机型合并且保留机型清单',async()=>{
 const issue={rule:'横向溢出',class:'btn page',level:'P0'};
 const r={screen:{width:320,height:568},device:{model:'A'},issues:[],pages:[{page:'one',issues:[issue]}]};
 const merged=mergeIssues([r,{...r,device:{model:'B'}}]);assert.equal(merged.length,1);assert.equal(merged[0].devices.length,2);
});
console.log(passed+' 项批量 UI 回归通过');
