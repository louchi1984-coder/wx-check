#!/usr/bin/env node
/**
 * 诊断服务读取与模块发现回归 —— 注入读取函数，不连接开发者工具。
 *   node scripts/diagnostics-selftest.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverDeviceModules, discoverDiagnosticModules } from './lib/diagnostic-modules.mjs';
import { readEditorPanels } from './lib/editor-diagnostics.mjs';

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('✓ ' + name); }
  catch (e) { process.exitCode = 1; console.log('✗ ' + name + '\n  ' + e.message); }
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-check-diag-'));
const project = path.join(root, 'app');
const out = path.join(root, 'evidence');
fs.mkdirSync(project);
fs.mkdirSync(out);
fs.writeFileSync(path.join(project, 'app.json'), '{"pages":[]}');

try {
  const editorFixture=(markers=[],channels=[])=>{
    const calls=[];
    const services={markerService:{read:()=>markers},outputService:{getChannelDescriptors:()=>channels.map(c=>c.descriptor),getActiveChannel:()=>channels[0],getChannel:id=>channels.find(c=>c.descriptor.id===id)}};
    return {calls,editor:{isInited:true,getVsEditorExt:()=>({createDecorator:id=>id}),workbench:{instantiationService:{invokeFunction:fn=>fn({get:id=>{calls.push(id);return services[id]}})}}}};
  };
  t('编辑器未初始化明确要求完整模式，不把空列表当通过',()=>{
    const r=readEditorPanels({editor:{isInited:false},project,fs,path});
    assert.equal(r.problems.available,false);assert.match(r.problems.reason,/完整模式/);
  });
  t('真实服务调用方式读取问题列表，区分工程内外，保留位置与来源',()=>{
    const {editor,calls}=editorFixture([{resource:{fsPath:path.join(project,'app.js'),toString:()=> 'file://'+path.join(project,'app.js')},severity:8,message:'语法错误',source:'js',startLineNumber:3,startColumn:5},{resource:{fsPath:path.join(root,'other.js'),toString:()=> 'file://'+path.join(root,'other.js')},severity:4,message:'外部告警'}]);
    const r=readEditorPanels({editor,project,fs,path});
    assert.equal(r.problems.available,true);assert.equal(r.problems.markers.length,2);assert.equal(r.problems.markers[0].inProject,true);assert.equal(r.problems.markers[1].inProject,false);assert.equal(r.problems.markers[0].line,3);assert.deepEqual(calls,['markerService','outputService']);
  });
  t('已初始化服务返回空问题列表才记录当前列表为空',()=>{
    const {editor}=editorFixture();const r=readEditorPanels({editor,project,fs,path});
    assert.equal(r.problems.available,true);assert.deepEqual(r.problems.markers,[]);assert.equal(r.output.available,true);assert.deepEqual(r.output.channels,[]);
  });
  t('输出读取当前模型全文，不切换面板或修改通道',()=>{
    const {editor}=editorFixture([],[{descriptor:{id:'ext',label:'Extension Host'},model:{model:{getValue:()=> 'Error: test\nsecond line'}}}]);
    const r=readEditorPanels({editor,project,fs,path});assert.equal(r.output.channels[0].text,'Error: test\nsecond line');assert.equal(r.output.channels[0].strategy,'model');assert.equal(r.output.channels[0].complete,true);
  });
  t('无模型时按实际通道文件及清除偏移读取，不混入已清除旧记录',()=>{
    const file=path.join(out,'channel.log');fs.writeFileSync(file,'old\nnew\n');
    const {editor}=editorFixture([],[{descriptor:{id:'build',label:'Build',file:{scheme:'file',fsPath:file,toString:()=> 'file://'+file}},model:{startOffset:4}}]);
    const r=readEditorPanels({editor,project,fs,path});assert.equal(r.output.channels[0].text,'new\n');assert.equal(r.output.channels[0].strategy,'file');assert.equal(r.output.channels[0].complete,true);
  });
  t('文件偏移未知或采集截断不冒充面板全文已读取',()=>{
    const file=path.join(out,'channel-unbound.log');fs.writeFileSync(file,'some log');
    const {editor}=editorFixture([],[{descriptor:{id:'unknown',file:{scheme:'file',fsPath:file}},model:{}}]);
    assert.equal(readEditorPanels({editor,project,fs,path}).output.channels[0].complete,false);
    const capped=editorFixture([],[{descriptor:{id:'long'},model:{model:{getValue:()=> '123456789'}}}]);
    const c=readEditorPanels({editor:capped.editor,project,fs,path,maxBytes:4}).output.channels[0];assert.equal(c.complete,false);assert.equal(c.truncated,true);
  });
  t('通道不可读记录具体错误，不因其他通道成功而隐藏',()=>{
    const {editor}=editorFixture([],[{descriptor:{id:'missing',file:{scheme:'file',fsPath:path.join(out,'absent.log')}},model:{startOffset:0}},{descriptor:{id:'memory'},model:{model:{getValue:()=> 'ok'}}}]);
    const r=readEditorPanels({editor,project,fs,path});assert.equal(r.output.channels[0].available,false);assert.match(r.output.channels[0].reason,/ENOENT/);assert.equal(r.output.channels[1].available,true);
  });
  t('服务缺失时逐面板失败；不初始化、不调用界面命令',()=>{
    const editor={isInited:true,workbench:{instantiationService:{}},setupWorkbench:()=>{throw Error('禁止初始化')}};
    const r=readEditorPanels({editor,project,fs,path});assert.equal(r.problems.available,false);assert.match(r.problems.reason,/服务访问能力变化/);assert.equal(r.output.available,false);
  });
  t('编辑器标识按导出能力发现，缺失或重复只影响编辑器面板',()=>{
    const entries=[{file:'s.js',source:'IStoreService getState: subscribe: unsubscribe: exports.default=function'},{file:'f.js',source:'exports.getRootFactory= invokeFunction exports.default='},{file:'b.js',source:'exports.IMessageHubService= createDecorator'},{file:'q.js',source:'exports.IWebCodeQualityService= createDecorator'},{file:'renamed.js',source:'exports.IEditorWorkbenchService= createDecorator'}];
    assert.equal(discoverDiagnosticModules(entries).editor,'renamed.js');assert.equal(discoverDiagnosticModules(entries.slice(0,4)).editor,null);assert.match(discoverDiagnosticModules([...entries,entries[4]]).editorDiscoveryError,/2/);
  });
  t('机型模块按能力发现，文件改名仍可用；缺失或重复不猜',()=>{
    const entries=[{file:'new-store.js',source:'IStoreService getState: subscribe: unsubscribe: exports.default=function'},
      {file:'new-services.js',source:'exports.getRootFactory= invokeFunction exports.default='},
      {file:'new-actions.js',source:'selectDevice:function TOOLBAR_SELECT_DEVICE toolbar.device.list'},
      {file:'new-bridge.js',source:'exports.IAutomatorBridgeService= createDecorator'}];
    assert.deepEqual(discoverDeviceModules(entries),{store:'new-store.js',services:'new-services.js',actions:'new-actions.js',bridge:'new-bridge.js'});
    assert.throws(()=>discoverDeviceModules(entries.slice(1)),/无法唯一/);
    assert.throws(()=>discoverDeviceModules([...entries,entries[0]]),/无法唯一/);
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(pass + ' 项诊断面板回归通过' + (process.exitCode ? '，存在失败项' : ''));
