import { PictureOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import DOMPurify from 'dompurify';
import { useEffect, useMemo, useRef, useState } from 'react';
import { attachmentUrl, type MessageDetail } from '../api';
import { t } from '../i18n';

const REMOTE_PATTERN = /(?:src|background|srcset)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function textToHtml(text: string) {
  const escaped = escapeHtml(text);
  const linked = escaped.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1">$1</a>');
  return `<pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit;margin:0">${linked}</pre>`;
}

/**
 * 构建 iframe srcdoc：
 * - DOMPurify 清洗（去脚本、事件属性等）
 * - cid: 内嵌图片改写为同源附件地址
 * - 用 CSP 拦截远程资源（追踪像素），用户点击后才放行
 * - iframe 不给 allow-scripts，即使清洗遗漏也无法执行脚本
 */
function buildSrcDoc(message: MessageDetail, allowRemote: boolean) {
  let html = message.html ?? textToHtml(message.text ?? '');
  for (const att of message.attachments) {
    if (!att.cid) continue;
    const cid = att.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(`cid:${cid}`, 'gi'), attachmentUrl(message.id, att.index, true));
  }
  const clean = DOMPurify.sanitize(html, {
    FORCE_BODY: true,
    WHOLE_DOCUMENT: false,
    FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select'],
  });
  const remote = allowRemote ? ' https: http:' : '';
  const csp = `default-src 'none'; img-src 'self' data:${remote}; style-src 'unsafe-inline'${remote}; font-src data:${remote}; media-src 'self'${remote}`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
  html,body{margin:0;padding:0;background:#fff}
  body{padding:16px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f1f1f;word-break:break-word;overflow-wrap:anywhere}
  img{max-width:100%;height:auto}
  table{max-width:100%}
  blockquote{margin:0 0 0 8px;padding-left:12px;border-left:3px solid #ddd;color:#555}
  a{color:#1677ff}
</style></head><body>${clean}</body></html>`;
}

export function EmailBody({ message }: { message: MessageDetail }) {
  const [allowRemote, setAllowRemote] = useState(false);
  const [height, setHeight] = useState(120);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  const hasRemote = useMemo(() => Boolean(message.html && REMOTE_PATTERN.test(message.html)), [message.html]);
  const srcDoc = useMemo(() => buildSrcDoc(message, allowRemote), [message, allowRemote]);

  useEffect(() => () => roRef.current?.disconnect(), []);

  // allow-same-origin 让父页面能读取高度并携带登录态加载内嵌图片；不开 allow-scripts，邮件内容无法执行任何脚本
  const onLoad = () => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    const measure = () => setHeight(Math.max(60, doc.documentElement.scrollHeight));
    measure();
    roRef.current?.disconnect();
    roRef.current = new ResizeObserver(measure);
    roRef.current.observe(doc.body);
  };

  return (
    <div>
      {hasRemote && !allowRemote && (
        <div className="remote-blocked">
          <PictureOutlined />
          <span>{t.editor.imagesBlocked}</span>
          <Button type="link" size="small" onClick={() => setAllowRemote(true)}>
            {t.editor.showImages}
          </Button>
        </div>
      )}
      <iframe
        ref={frameRef}
        title={`message-${message.id}`}
        className="email-frame"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc}
        onLoad={onLoad}
        style={{ height }}
      />
    </div>
  );
}
