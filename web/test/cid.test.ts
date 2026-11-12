/**
 * 邮件正文里 cid: 内嵌图片的改写（web/src/lib/cid.ts）
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { rewriteCids } from '../src/lib/cid.ts';

const url = (i: number) => `/att/${i}`;

describe('rewriteCids', () => {
  test('按 Content-ID 精确替换，不区分大小写，CSS url() 里也替换', () => {
    const html = '<img src="cid:Logo@x"><img src="cid:logo@x.more"><div style="background:url(cid:BG@x)"></div>';
    const out = rewriteCids(html, [{ cid: 'logo@x', index: 1 }, { cid: 'bg@x', index: 2 }], url);
    assert.equal(out, '<img src="/att/1"><img src="cid:logo@x.more"><div style="background:url(/att/2)"></div>');
  });

  test('没有附件或没有匹配时原样返回', () => {
    assert.equal(rewriteCids('<img src="cid:a">', [], url), '<img src="cid:a">');
    assert.equal(rewriteCids('<img src="cid:a">', [{ cid: null, index: 0 }], url), '<img src="cid:a">');
  });

  test('大量附件和大正文也是线性时间', () => {
    const attachments = Array.from({ length: 5000 }, (_, i) => ({ cid: `img${i}@x`, index: i }));
    const html = attachments.map((a) => `<img src="cid:${a.cid}">`).join('').repeat(20);
    const started = performance.now();
    const out = rewriteCids(html, attachments, url);
    assert.ok(performance.now() - started < 1000);
    assert.ok(!out.includes('cid:'));
  });
});
