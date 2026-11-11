import { Alert, Spin } from 'antd';
import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { t } from '../i18n';

// 对话面板依赖 Ant Design X 和 Markdown 渲染，体积较大，第一次打开时再加载
const AssistantPanel = lazy(() => import('./AssistantPanel'));

/** 助手面板出错时只影响它自己，不让整个页面白屏 */
class PanelBoundary extends Component<{ children: ReactNode; onReset: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Alert
        type="error"
        showIcon
        closable={{ onClose: this.props.onReset }}
        title={t.assistant.panelError}
        description={this.state.error.message}
        style={{ position: 'fixed', insetInlineEnd: 24, insetBlockEnd: 24, zIndex: 1000, maxWidth: 360 }}
      />
    );
  }
}

/** 第一次打开前预加载对话面板（悬停在入口上时调用） */
export const preloadAssistant = () => void import('./AssistantPanel');

export const ASSISTANT_EXPANDED_KEY = 'damail.assistant.fullscreen';

export function readAssistantPref(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeAssistantPref(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 无痕模式存不了，只在本次打开期间生效
  }
}

export type AssistantProps = {
  open: boolean;
  /** 展开成占满内容区的工作区；否则是右下角的浮动小窗 */
  expanded: boolean;
  username: string;
  onClose: () => void;
  onExpand: (expanded: boolean) => void;
};

/** 对话面板：入口在左侧图标栏（AppLayout），默认是右下角的浮动小窗，可以展开占满内容区；第一次打开时才加载，关闭后保留对话状态 */
export function Assistant(props: AssistantProps) {
  const { open, expanded, onClose } = props;
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  if (!mounted) return null;
  return (
    <PanelBoundary
      onReset={() => {
        onClose();
        setMounted(false);
      }}
    >
      <Suspense
        fallback={
          <aside className={`assistant-dock ${expanded ? 'expanded' : 'floating'}`}>
            <div className="assistant-main" style={{ alignItems: 'center', justifyContent: 'center' }}>
              <Spin />
            </div>
          </aside>
        }
      >
        <AssistantPanel {...props} />
      </Suspense>
    </PanelBoundary>
  );
}
