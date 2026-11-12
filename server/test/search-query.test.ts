/**
 * 搜索语法解析（docs/search.md），重点是相对日期。纯函数，不需要数据库。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseSearchQuery } from '../src/lib/search-query.js';

// 固定「现在」：2026-11-12 15:30（本地时区）
const NOW = new Date(2026, 10, 12, 15, 30);
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

describe('parseSearchQuery', () => {
  test('基本条件和关键词', () => {
    const q = parseSearchQuery('from:amazon is:unread has:attachment category:Finance "季度 预算" -广告 发票', NOW);
    assert.deepEqual(q.from, ['amazon']);
    assert.equal(q.isUnread, true);
    assert.equal(q.hasAttachment, true);
    assert.deepEqual(q.category, ['finance']);
    assert.deepEqual(q.terms, ['季度 预算', '发票']);
    assert.deepEqual(q.excludes, ['广告']);
  });

  test('绝对日期按本地零点', () => {
    const q = parseSearchQuery('after:2026-10-01 before:2026-11-01', NOW);
    assert.equal(q.after?.getTime(), day(2026, 10, 1));
    assert.equal(q.before?.getTime(), day(2026, 11, 1));
  });

  test('相对日期', () => {
    const at = (v: string) => parseSearchQuery(`after:${v}`, NOW).after?.getTime();
    assert.equal(at('today'), day(2026, 11, 12));
    assert.equal(at('Today'), day(2026, 11, 12));
    assert.equal(at('yesterday'), day(2026, 11, 11));
    assert.equal(at('1d'), day(2026, 11, 12));
    assert.equal(at('7d'), day(2026, 11, 6));
    assert.equal(at('30d'), day(2026, 10, 14));
    assert.equal(at('2w'), day(2026, 10, 30));
    assert.equal(at('3m'), day(2026, 8, 12));
    assert.equal(at('1y'), day(2025, 11, 12));
    assert.equal(parseSearchQuery('before:today', NOW).before?.getTime(), day(2026, 11, 12));
  });

  test('认不出的日期忽略', () => {
    const q = parseSearchQuery('after:7x after:someday', NOW);
    assert.equal(q.after, undefined);
  });
});
