import { useQueryClient } from '@tanstack/react-query';
import { App, Modal, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { api, type Account } from '../api';
import { t } from '../i18n';
import { RichEditor } from './RichEditor';

/** 编辑某个邮箱的签名：写信时附在正文后面（可在写信时取消） */
export function SignatureModal({
  account,
  open,
  onClose,
}: {
  account: Pick<Account, 'id' | 'email' | 'signatureHtml'> | null;
  open: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [html, setHtml] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setHtml(account?.signatureHtml ?? '');
  }, [open, account]);

  const save = async () => {
    if (!account) return;
    setSaving(true);
    try {
      await api(`/api/admin/accounts/${account.id}/signature`, { method: 'PUT', body: { signatureHtml: html || null } });
      await qc.invalidateQueries({ queryKey: ['admin-accounts'] });
      message.success(t.compose.signatureSaved);
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t.compose.signatureTitle(account?.email ?? '')}
      okText={t.common.save}
      confirmLoading={saving}
      onOk={save}
      onCancel={onClose}
      width={640}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        {t.compose.signatureHint}
      </Typography.Paragraph>
      <div className="signature-editor">
        <RichEditor value={account?.signatureHtml ?? ''} placeholder={t.compose.signaturePlaceholder} onChange={setHtml} />
      </div>
    </Modal>
  );
}
