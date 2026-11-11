/**
 * 正文里的退订链接：没有 List-Unsubscribe 头的营销邮件，从正文里找退订链接；
 * 不该误判的（只有偏好设置、回复转发、非 http 链接）不返回。纯函数，不需要数据库。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BODY_SCAN_VERSION, findBodyUnsubscribe, needsBodyScan, withBodyUnsubscribe } from '../src/lib/body-unsubscribe.js';

const html = (body: string) => ({ subject: 'Weekly update', htmlBody: `<html><body>${body}</body></html>` });

describe('正文退订链接', () => {
  test('链接文字是 Unsubscribe', () => {
    const m = html(`
      <a href="https://example.com/blog">Read more</a>
      <p>You received this email because you signed up.</p>
      <a href="https://mail.example.com/u/abc123?e=1&amp;t=2">Unsubscribe from Updates</a>
      <a href="https://example.com/privacy">Privacy</a>`);
    assert.equal(findBodyUnsubscribe(m), 'https://mail.example.com/u/abc123?e=1&t=2');
  });

  test('中文「退订」和日文「配信停止」', () => {
    assert.equal(findBodyUnsubscribe(html('<a href="https://a.cn/x?id=9">点此退订</a>')), 'https://a.cn/x?id=9');
    assert.equal(findBodyUnsubscribe(html('<a href="https://a.jp/stop">配信停止はこちら</a>')), 'https://a.jp/stop');
  });

  test('链接文字是「点击这里」，前文说的是退订', () => {
    const m = html('<p>If you no longer wish to receive these emails, <a href="https://x.io/r/7">click here</a>.</p><a href="https://x.io/home">Home</a>');
    assert.equal(findBodyUnsubscribe(m), 'https://x.io/r/7');
  });

  test('只有地址里带 unsubscribe（图片按钮）', () => {
    const m = html('<a href="https://x.io/"><img src="logo.png"></a><a href="https://list.x.io/unsubscribe?u=1"><img src="btn.png"></a>');
    assert.equal(findBodyUnsubscribe(m), 'https://list.x.io/unsubscribe?u=1');
  });

  test('图片 alt 是 Unsubscribe', () => {
    assert.equal(findBodyUnsubscribe(html('<a href="https://t.x.io/c/1"><img alt="Unsubscribe" src="b.png"></a>')), 'https://t.x.io/c/1');
  });

  test('明确的退订链接优先于「管理订阅」', () => {
    const m = html('<a href="https://x.io/unsub/1">Unsubscribe</a> · <a href="https://x.io/prefs">Manage preferences</a>');
    assert.equal(findBodyUnsubscribe(m), 'https://x.io/unsub/1');
  });

  test('「管理订阅」只在正文提到退订时才算', () => {
    assert.equal(findBodyUnsubscribe(html('<p>To unsubscribe, visit</p><a href="https://x.io/settings">Manage your email preferences</a>')), 'https://x.io/settings');
    // 银行通知：只有通知偏好设置，没有提到退订，不当作订阅
    assert.equal(findBodyUnsubscribe(html('<p>Your statement is ready.</p><a href="https://bank.example/alerts">Manage notification preferences</a>')), null);
  });

  test('付费订阅的管理页不是退订', () => {
    // App Store 订阅确认邮件：正文提到「取消订阅」，链接是查看订阅
    const m = html('<p>你的订阅已确认。如需取消订阅，请前往设置。</p><a href="https://apps.apple.com/account/subscriptions?mt=8">查看你的订阅</a>');
    assert.equal(findBodyUnsubscribe(m), null);
  });

  test('普通邮件、mailto 和 javascript 链接都不算', () => {
    assert.equal(findBodyUnsubscribe(html('<p>Hi, see <a href="https://docs.example/a">the doc</a>.</p>')), null);
    assert.equal(findBodyUnsubscribe(html('<a href="mailto:leave@x.io">Unsubscribe</a>')), null);
    assert.equal(findBodyUnsubscribe(html('<a href="javascript:alert(1)">Unsubscribe</a>')), null);
  });

  test('正文提到退订但链接不是「点这里」，不乱认', () => {
    const m = html('<p>Reply STOP to unsubscribe.</p><a href="https://x.io/terms">Terms</a> <a href="https://x.io/about">About us</a>');
    assert.equal(findBodyUnsubscribe(m), null);
  });

  test('回复和转发的邮件不找（可能引用了别人的营销邮件）', () => {
    const body = '<a href="https://x.io/unsub">Unsubscribe</a>';
    assert.equal(findBodyUnsubscribe({ subject: 'Re: Weekly update', htmlBody: body }), null);
    assert.equal(findBodyUnsubscribe({ subject: '转发：周报', htmlBody: body }), null);
    assert.equal(findBodyUnsubscribe({ subject: 'Weekly update', inReplyTo: '<a@b>', htmlBody: body }), null);
  });

  test('纯文本邮件：退订说明后面的网址', () => {
    const m = { subject: 'News', textBody: 'Thanks for reading.\nhttps://x.io/post/1\n\nTo unsubscribe, go to https://x.io/r?id=5.\n' };
    assert.equal(findBodyUnsubscribe(m), 'https://x.io/r?id=5');
  });

  test('邮件头有退订方式时以邮件头为准；没有时标记来源和规则版本', () => {
    const header = { http: 'https://h.io/u', oneClick: true };
    assert.deepEqual(withBodyUnsubscribe(header, html('<a href="https://b.io/u">Unsubscribe</a>')), header);
    assert.deepEqual(withBodyUnsubscribe({}, html('<a href="https://b.io/u">Unsubscribe</a>')), { http: 'https://b.io/u', source: 'body', bodyScan: BODY_SCAN_VERSION });
    const none = withBodyUnsubscribe({ id: 'x' }, html('<p>hello</p>'));
    assert.deepEqual(none, { id: 'x', bodyScan: BODY_SCAN_VERSION });
    // 正文找到的链接不会被当成一键退订
    assert.equal(withBodyUnsubscribe({}, html('<a href="https://b.io/u">Unsubscribe</a>')).oneClick, undefined);
    assert.equal(needsBodyScan(none), false);
    assert.equal(needsBodyScan({}), true);
    assert.equal(needsBodyScan({ mailto: 'mailto:a@b' }), false);
    // 规则升级后，之前从正文找到的链接会重新找；新规则找不到就去掉
    const old = { http: 'https://apps.apple.com/account/subscriptions', source: 'body' as const, bodyScan: BODY_SCAN_VERSION - 1 };
    assert.equal(needsBodyScan(old), true);
    assert.deepEqual(withBodyUnsubscribe(old, html('<p>如需取消订阅</p><a href="https://apps.apple.com/account/subscriptions">查看你的订阅</a>')), {
      bodyScan: BODY_SCAN_VERSION,
    });
    // 邮件头里的链接不受影响
    assert.equal(needsBodyScan({ http: 'https://h.io/u', bodyScan: 0 }), false);
  });
});
