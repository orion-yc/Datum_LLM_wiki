import test from 'node:test';
import assert from 'node:assert/strict';
import { rankChunks, splitText, markdownChunks, tokens } from '../server/retrieval.mjs';
import { calendarDate } from '../server/calendar.mjs';

test('中文、英文检索保留术语并优先匹配相关原文', () => {
  assert.ok(tokens('二分查找 O(log n) binary search').includes('二分'));
  const chunks = [
    { id: 'a', heading: '二分查找', content: '有序序列的二分查找，边界更新需要维持循环不变量。', position: 0 },
    { id: 'b', heading: '植物学', content: '叶绿体参与光合作用。', position: 1 },
    { id: 'c', heading: 'Binary search', content: 'Binary search requires sorted input.', position: 2 },
  ];
  assert.equal(rankChunks('二分查找的边界', chunks)[0].id, 'a');
  assert.equal(rankChunks('binary search', chunks)[0].id, 'c');
  assert.equal(rankChunks('quasarflorp', chunks).length, 0);
  assert.equal(rankChunks('', chunks).length, 0);
});
test('长正文切片覆盖原文并保留重叠，没有丢失尾部', () => {
  const text = '有序序列。每次缩小查找区间。\n'.repeat(700) + '唯一尾部标记';
  const parts = splitText(text);
  assert.ok(parts.length > 5);
  assert.ok(parts.every(p => p.length <= 1100));
  assert.ok(parts.at(-1).endsWith('唯一尾部标记'));
  assert.ok(parts.every(p => text.includes(p)));
});
test('Markdown 章节标题与内容一一对应，空资料不产生伪片段', () => {
  const chunks = markdownChunks('# 第一章\n正文解释。\n## 第二节\n第二节内容。');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].heading, '第一章');
  assert.equal(chunks[1].heading, '第二节');
  assert.equal(chunks[1].page, 2);
  assert.deepEqual(markdownChunks(' \n'), []);
});
test('复习日历按上海日期处理跨 UTC 午夜边界', () => {
  assert.equal(calendarDate(new Date('2026-11-13T16:30:00.000Z'), 'Asia/Shanghai'), '2026-11-14');
  assert.equal(calendarDate(new Date('2026-11-13T15:59:00.000Z'), 'Asia/Shanghai'), '2026-11-13');
});
