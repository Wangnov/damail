import { EditOutlined, EyeOutlined } from '@ant-design/icons';
import { Button, Segmented, Tooltip } from 'antd';
import { useDeferredValue, useState, type KeyboardEvent } from 'react';
import { t } from '../i18n';

/** 在隔离的 iframe 里显示 HTML：不执行脚本、不能访问 DaMail 页面 */
export function HtmlPreview({ html, className }: { html: string; className?: string }) {
  return (
    <iframe
      className={className ?? 'html-preview'}
      title={t.compose.htmlPreview}
      sandbox=""
      // 让预览和发出去的效果接近：白底、系统字体
      srcDoc={`<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{margin:16px;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#1f1f1f;background:#fff;word-break:break-word}img{max-width:100%}</style>${html}`}
    />
  );
}

/** HTML 源码模式：左边编辑源码，右边实时预览；窄屏切换显示 */
export function HtmlSourceEditor({
  value,
  onChange,
  onExit,
  narrow,
}: {
  value?: string;
  onChange?: (html: string) => void;
  onExit: () => void;
  narrow?: boolean;
}) {
  const html = value ?? '';
  const preview = useDeferredValue(html);
  const [view, setView] = useState<'source' | 'preview'>('source');

  // Tab 插入两个空格，不跳出输入框
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: a, selectionEnd: b } = el;
    onChange?.(html.slice(0, a) + '  ' + html.slice(b));
    requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
  };

  return (
    <div className={`html-source${narrow ? ' is-narrow' : ''}`}>
      <div className="html-source-bar">
        <span className="html-source-badge">HTML</span>
        <span className="html-source-hint">{t.compose.htmlHint}</span>
        {narrow && (
          <Segmented
            size="small"
            value={view}
            onChange={(v) => setView(v as 'source' | 'preview')}
            options={[
              { value: 'source', icon: <EditOutlined />, label: t.compose.htmlSource },
              { value: 'preview', icon: <EyeOutlined />, label: t.compose.htmlPreview },
            ]}
          />
        )}
        <Tooltip title={t.compose.backToRichTip} mouseEnterDelay={0.5}>
          <Button size="small" onClick={onExit}>
            {t.compose.backToRich}
          </Button>
        </Tooltip>
      </div>
      <div className="html-source-panes">
        {(!narrow || view === 'source') && (
          <textarea
            className="html-source-code"
            value={html}
            spellCheck={false}
            placeholder={t.compose.htmlPlaceholder}
            aria-label={t.compose.htmlSource}
            onChange={(e) => onChange?.(e.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
        {(!narrow || view === 'preview') && <HtmlPreview html={preview} />}
      </div>
    </div>
  );
}
