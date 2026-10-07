#!/usr/bin/env node
/** 点击入口静态解析回归（动态类名、空函数体）。不连接开发者工具。 */
import assert from 'node:assert/strict';
import { classTokens, tapTargets } from './lib/nav-cost.mjs';
import { formInputs, methodBodyOrNull, methodBody } from './lib/ux-audit.mjs';

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('✓ ' + name); }
  catch (e) { process.exitCode = 1; console.log('✗ ' + name + '\n  ' + e.message); }
};

t('classTokens：动态表达式整体摘掉，只留静态类名并标记 dynamic', () => {
  assert.deepEqual(classTokens('slot s-{{item.state}}'), { classes: ['slot'], dynamic: true });
  assert.deepEqual(classTokens("date-item {{item.key === activeDate ? 'on' : ''}} {{item.isRest ? 'rest' : ''}}"), { classes: ['date-item'], dynamic: true });
  assert.deepEqual(classTokens('a b'), { classes: ['a', 'b'], dynamic: false });
  assert.deepEqual(classTokens('{{x}}'), { classes: [], dynamic: true });
  assert.deepEqual(classTokens(''), { classes: [], dynamic: false });
});
t('tapTargets：选择器不再带 {{…}}', () => {
  const [x] = tapTargets('<view class="slot s-{{item.state}}" bindtap="onPickSlot">x</view>');
  assert.deepEqual(x.classes, ['slot']);
  assert.equal(x.dynamicClass, true);
});
t('formInputs：输入控件的动态 class 也不拼进选择器', () => {
  const [i] = formInputs('<input class="field f-{{state}}" />');
  assert.deepEqual(i.classes, ['field']);
  assert.equal(i.dynamicClass, true);
});
t('methodBodyOrNull：空函数体是空串，找不到才是 null', () => {
  const js = 'Page({ noop: function () {}, other() { var a = 1 } })';
  assert.equal(methodBodyOrNull(js, 'noop'), '');
  assert.notEqual(methodBodyOrNull(js, 'other'), null);
  assert.equal(methodBodyOrNull(js, 'missing'), null);
  assert.equal(methodBody(js, 'missing'), '');
});
console.log(pass + ' 项点击入口静态解析回归通过' + (process.exitCode ? '，存在失败项' : ''));
