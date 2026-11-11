import { TranslationOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { App, Flex, Space, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';
import { api, type MessageDetail, type Translation } from '../api';
import { fullDate } from '../lib/format';
import { EmailBody } from './EmailBody';
import { t } from '../i18n';

/** 一封邮件的翻译状态：译文从会话详情里带过来，翻译后写回缓存 */
export function useMessageTranslation(message: MessageDetail) {
  const qc = useQueryClient();
  const { message: toast } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const translation = message.translation ?? null;

  const translate = async (force = false) => {
    setLoading(true);
    try {
      const result = await api<Translation>(`/api/v1/messages/${message.id}/translate`, { method: 'POST', body: { force } });
      qc.setQueryData<{ messages: MessageDetail[] }>(['thread', message.threadId], (old) =>
        old ? { ...old, messages: old.messages.map((m) => (m.id === message.id ? { ...m, translation: result } : m)) } : old,
      );
      setShowOriginal(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return { translation, loading, showOriginal, setShowOriginal, translate, showing: !!translation && !showOriginal };
}

/** 译文用原来的正文组件渲染（HTML 邮件只替换了文字，排版不变），上面一条提示栏 */
export function TranslationView({
  message,
  translation,
  loading,
  onOriginal,
  onRetranslate,
}: {
  message: MessageDetail;
  translation: Translation;
  loading: boolean;
  onOriginal: () => void;
  onRetranslate: () => void;
}) {
  const { token } = theme.useToken();
  // 正文组件按 message 生成 iframe 内容，换成新对象会重新加载，要记住
  const translated = useMemo(() => ({ ...message, html: translation.html, text: translation.body }), [message, translation]);
  return (
    <>
      <Flex
        justify="space-between"
        align="center"
        gap={12}
        wrap
        style={{ background: token.colorFillQuaternary, borderRadius: token.borderRadius, padding: '6px 12px', marginBottom: 8 }}
      >
        <Typography.Text
          type="secondary"
          ellipsis
          style={{ fontSize: 12, minWidth: 0, flex: 1 }}
          title={`${translation.model} · ${fullDate(translation.createdAt)}`}
        >
          <TranslationOutlined /> {t.editor.translatedTo(translation.language)}
          {translation.subject && <> · {translation.subject}</>}
        </Typography.Text>
        <Space size={12} style={{ flex: 'none' }}>
          <Typography.Link style={{ fontSize: 12 }} onClick={onOriginal}>
            {t.editor.viewOriginal}
          </Typography.Link>
          <Typography.Link style={{ fontSize: 12 }} disabled={loading} onClick={onRetranslate}>
            {loading ? t.editor.translating : t.editor.retranslate}
          </Typography.Link>
        </Space>
      </Flex>
      <EmailBody message={translated} />
    </>
  );
}
