#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStorageGuard} from './lib/storage-guard.mjs';
import {tapElement} from './lib/tap-audit.mjs';
import {auditUx,formFillPlan} from './lib/ux-audit.mjs';
let passed=0;
function test(name,fn){fn();passed++;console.log('通过：'+name)}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wx-check-regression-'));
function storage(initial){const data=new Map(Object.entries(initial));let failWrite=false;const wx={getStorageInfoSync:()=>({keys:[...data.keys()]}),getStorageSync:k=>data.get(k),setStorageSync:(k,v)=>{if(failWrite)throw Error('write denied');data.set(k,v)},removeStorageSync:k=>data.delete(k)};return {data,fail:()=>{failWrite=true},call:(_,args)=>({ok:true,result:{result:Function('wx','return ('+args[args.indexOf('--fn-source')+1]+')()')(wx)}})}}
try {
test('条件按钮未出现时不点击、不报程序缺陷',()=>{let n=0;assert.match(tapElement('/fixture',null,'.confirm',()=>{n++;return {result:{elements:[]}}}).skipped,/前置|条件|出现/);assert.equal(n,1)});
test('多个同名按钮时不猜测点击',()=>assert.ok(tapElement('/fixture',null,'.confirm',()=>({result:{elements:[{},{}]}})).skipped));
test('唯一按钮才执行真实点击',()=>{let n=0;assert.equal(tapElement('/fixture',null,'.confirm',()=>++n===1?{result:{elements:[{}]}}:{result:{success:true}}).ok,true);assert.equal(n,2)});
test('工具失败记录未覆盖',()=>assert.ok(tapElement('/fixture',null,'.confirm',()=>{throw Error('timeout')}).skipped));
test('恢复全部原键、值及删除新增键',()=>{const m=storage({a:{x:1},b:[1,2]});const g=createStorageGuard('/fixture',null,{call:m.call,backupDir:path.join(root,'normal')});m.data.set('a',9);m.data.delete('b');m.data.set('test',4);assert.equal(g.restore(),true);assert.deepEqual(Object.fromEntries(m.data),{a:{x:1},b:[1,2]});assert.ok(fs.existsSync(g.backupFile))});
test('空存储备份是合法成功结果',()=>{const m=storage({});const g=createStorageGuard('/fixture',null,{call:m.call,backupDir:path.join(root,'empty')});m.data.set('new',1);assert.equal(g.restore(),true);assert.equal(m.data.size,0)});
test('读取失败不能混同空存储',()=>assert.throws(()=>createStorageGuard('/fixture',null,{call:()=>({ok:false,message:'blocked'}),backupDir:path.join(root,'failed')}),/blocked/));
test('无法可靠保存的值拒绝开始',()=>{const m=storage({date:new Date()});assert.throws(()=>createStorageGuard('/fixture',null,{call:m.call,backupDir:path.join(root,'date')}),/不支持/)});
test('恢复写入失败不先删除现有数据',()=>{const m=storage({a:1});const g=createStorageGuard('/fixture',null,{call:m.call,backupDir:path.join(root,'writefail')});m.data.set('new',2);m.fail();assert.throws(()=>g.restore(),/write denied/);assert.equal(m.data.get('new'),2);assert.ok(fs.existsSync(g.backupFile))});
test('备份禁止写入工程目录',()=>assert.throws(()=>createStorageGuard(root,null,{call:storage({}).call,backupDir:path.join(root,'inside')}),/工程外/));
const inputs=[{tag:'input',classes:['name']},{tag:'textarea',classes:['note']}];
test('多字段缺值不冒充合法提交',()=>assert.ok(formFillPlan(inputs,{'.name':'张三'}).error));
test('多字段逐个生成输入计划',()=>assert.deepEqual(formFillPlan(inputs,{'.name':'张三','.note':'备注'}).fields.map(x=>x.value),['张三','备注']));
test('选择器控件需独立业务场景',()=>assert.ok(formFillPlan([{tag:'picker',classes:['pick']}],{}).error));
function run({throwFill=false,restoreFail=false,backupFail=false}={}){let restored=0,taps=0;const values={};const driver={enter:()=>true,count:()=>1,fill:(s,v)=>{if(throwFill)throw Error('input failed');values[s]=v;return {ok:true}},value:s=>values[s],tap:()=>{taps++;return {ok:true}},snap:()=>({page:'form',sig:'{}'}),sleep:()=>{},finish:()=>{}};const result=auditUx('/fixture',[{page:'form',tasks:[{text:'提交',selector:'.submit',inputs,feedbackApi:true}]}],null,()=>{},{driver,values:{form:{'.name':'张三','.note':'备注'}},guardFactory:()=>{if(backupFail)throw Error('backup failed');return {backupFile:'/backup',restore:()=>{restored++;if(restoreFail)throw Error('restore failed');return true}}}});return {result,restored,taps,values}}
test('备份失败零业务点击且报告未完成',()=>{const r=run({backupFail:true});assert.equal(r.taps,0);assert.equal(r.result.ran,false);assert.equal(r.result.incomplete,true)});
test('执行异常仍恢复存储',()=>{const r=run({throwFill:true});assert.equal(r.restored,1);assert.equal(r.taps,0);assert.equal(r.result.incomplete,true)});
test('恢复失败明确报告未完成',()=>{const r=run({restoreFail:true});assert.match(r.result.restoreError,/restore failed/);assert.equal(r.result.incomplete,true)});
test('空提交与正常提交均填写所有字段',()=>{const r=run();assert.equal(r.taps,2);assert.deepEqual(r.values,{'.name':'张三','.note':'备注'});assert.equal(r.restored,1);assert.match(r.result.hops[0].businessResult,/未/)});
console.log(`交互保护回归：${passed}项通过`);
} finally {fs.rmSync(root,{recursive:true,force:true})}
