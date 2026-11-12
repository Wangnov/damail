/**
 * 搜索框的纯逻辑（web/src/lib/search.ts）：中英文写法互转、光标处取词、补全和条件增删。
 * 用 Node 自带的测试和类型剥离运行：pnpm --filter web test
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  hasToken,
  keyOptions,
  localizeQuery,
  normalizeQuery,
  removeToken,
  replaceWord,
  toggleToken,
  tokenize,
  valueSpelling,
  wordAt,
} from '../src/lib/search.ts';

describe('normalizeQuery', () => {
  test('中文写法换成英文语法', () => {
    assert.equal(normalizeQuery(' 发件人:amazon  未读 分类:账单 发票 '), 'from:amazon is:unread category:finance 发票');
    assert.equal(normalizeQuery('优先级:高 需回复 有验证码 -广告'), 'priority:high is:needs-reply has:code -广告');
    assert.equal(normalizeQuery('文件夹：已发送 标签:"客户 A"'), 'folder:sent label:"客户 A"');
  });

  test('日期快捷词', () => {
    assert.equal(normalizeQuery('今天 近7天 近30天'), 'after:today after:7d after:30d');
    assert.equal(normalizeQuery('之后:3个月 之前:昨天 之后:2周 之后:2026-10-01'), 'after:3m before:yesterday after:2w after:2026-10-01');
  });

  test('英文前缀也能配中文值，引号原样保留', () => {
    assert.equal(normalizeQuery('category:账单 "未读 邮件" 10:30'), 'category:finance "未读 邮件" 10:30');
  });
});

describe('localizeQuery', () => {
  const samples = [
    'from:amazon is:unread category:finance 发票',
    'priority:high is:needs-reply -is:answered has:code',
    'folder:sent label:"客户 A" -label:旧 after:7d before:today',
    'after:2026-10-01 to:bob "exact phrase" -spam',
  ];

  test('中文界面显示中文写法，英文界面不变', () => {
    assert.equal(localizeQuery(samples[0]!, 'zh'), '发件人:amazon 未读 分类:账单 发票');
    assert.equal(localizeQuery(samples[1]!, 'zh'), '优先级:高 需回复 -已回复 有验证码');
    assert.equal(localizeQuery(samples[2]!, 'zh'), '文件夹:已发送 标签:"客户 A" -标签:旧 近7天 之前:今天');
    assert.equal(localizeQuery(samples[0]!, 'en'), samples[0]);
  });

  test('换回去和原来一样', () => {
    for (const q of samples) assert.equal(normalizeQuery(localizeQuery(q, 'zh')), q);
  });
});

describe('tokenize / removeToken / toggleToken', () => {
  test('拆词', () => {
    const list = tokenize('-from:"A B" 未读 word');
    assert.deepEqual(
      list.map((x) => [x.text, x.neg, x.key, x.value]),
      [
        ['-from:"A B"', true, 'from', 'A B'],
        ['未读', false, null, '未读'],
        ['word', false, null, 'word'],
      ],
    );
    assert.equal(tokenize('发件人:张三')[0]!.key, 'from');
  });

  test('去掉一个条件', () => {
    assert.equal(removeToken('from:a is:unread b', 1), 'from:a b');
  });

  test('快捷筛选：有就去掉，没有就加上', () => {
    assert.equal(toggleToken('发件人:a', 'is:unread'), 'from:a is:unread');
    assert.equal(toggleToken('发件人:a 未读', 'is:unread'), 'from:a');
    assert.equal(toggleToken('', 'after:today'), 'after:today');
    assert.equal(hasToken('未读', 'is:unread'), true);
    assert.equal(hasToken('-未读', 'is:unread'), false);
  });
});

describe('wordAt / replaceWord', () => {
  test('光标处的词', () => {
    const input = '未读 发件人:ama';
    const w = wordAt(input, input.length);
    assert.equal(w.text, '发件人:ama');
    assert.equal(w.key, 'from');
    assert.equal(w.value, 'ama');
    assert.equal(wordAt('未读 ', 3).text, '');
    assert.equal(wordAt('"季度 预', 5).inQuote, true);
    assert.equal(wordAt('-from:', 6).neg, true);
  });

  test('补全前缀不加空格，补全条件加空格', () => {
    const a = replaceWord('未读 分', { start: 3, end: 4 }, '分类:');
    assert.deepEqual(a, { value: '未读 分类:', cursor: 6 });
    const b = replaceWord('分类: 发票', { start: 0, end: 3 }, '分类:账单');
    assert.deepEqual(b, { value: '分类:账单 发票', cursor: 6 });
    const c = replaceWord('发票', { start: 2, end: 2 }, '未读');
    assert.deepEqual(c, { value: '发票 未读 ', cursor: 6 });
  });
});

describe('keyOptions / valueSpelling', () => {
  test('中文输入补中文写法', () => {
    const list = keyOptions('分');
    assert.equal(list[0]!.insert, '分类:');
    assert.ok(keyOptions('未').some((o) => o.insert === '未读'));
    assert.equal(keyOptions('今')[0]!.insert, '今天');
  });

  test('英文输入补英文写法', () => {
    assert.equal(keyOptions('fr')[0]!.insert, 'from:');
    assert.ok(keyOptions('unr').some((o) => o.insert === 'is:unread'));
    assert.ok(keyOptions('att').some((o) => o.insert === 'has:attachment'));
  });

  test('已经输完的不再联想自己', () => {
    assert.ok(!keyOptions('未读').some((o) => o.insert === '未读'));
  });

  test('值的写法', () => {
    assert.equal(valueSpelling('category', 'finance', 'zh'), '账单');
    assert.equal(valueSpelling('category', 'finance', 'en'), 'finance');
    assert.equal(valueSpelling('after', '7d', 'zh'), '7天');
    assert.equal(valueSpelling('label', '客户 A', 'zh'), '"客户 A"');
  });
});
