import { useQueryClient } from '@tanstack/react-query';
import { App, Form, Input, Modal } from 'antd';
import { useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { horizontalForm, tip } from '../lib/form';

type Values = { username: string; currentPassword: string; newPassword?: string; confirmPassword?: string };

/** 修改登录用户名 / 密码。改密码后其他设备上的登录会失效 */
export function AccountSettingsModal({ open, username, onClose }: { open: boolean; username: string; onClose: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const [saving, setSaving] = useState(false);
  const nextName = (Form.useWatch('username', form) ?? username).trim();
  const newPassword = Form.useWatch('newPassword', form);
  // 没有改动时保存按钮不可点
  const dirty = Boolean(newPassword) || (nextName !== '' && nextName !== username);

  const save = async (values: Values) => {
    setSaving(true);
    try {
      await api('/api/auth/account', {
        method: 'PUT',
        body: { currentPassword: values.currentPassword, username: values.username.trim(), newPassword: values.newPassword || undefined },
      });
      message.success(values.newPassword ? t.auth.savedLoggedOut : t.common.saved);
      await qc.invalidateQueries({ queryKey: ['auth'] });
      onClose();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t.auth.accountTitle}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={t.common.save}
      okButtonProps={{ disabled: !dirty }}
      confirmLoading={saving}
      width={440}
      destroyOnHidden
    >
      <Form
        form={form}
        {...horizontalForm(undefined, { marginTop: 16 })}
        className="form-compact"
        requiredMark={false}
        initialValues={{ username }}
        preserve={false}
        onFinish={save}
      >
        <Form.Item name="username" label={t.auth.username} rules={[{ required: true, whitespace: true, message: t.auth.usernameEmpty }, { max: 64 }]}>
          <Input autoComplete="username" />
        </Form.Item>
        <Form.Item
          name="currentPassword"
          label={t.auth.currentPassword}
          tooltip={tip(t.auth.currentPasswordTip)}
          rules={[{ required: true, message: t.auth.currentPasswordRequired }]}
        >
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label={t.auth.newPassword}
          tooltip={tip(t.auth.newPasswordTip)}
          rules={[{ min: 8, message: t.auth.newPasswordMin }, { max: 200 }]}
        >
          <Input.Password autoComplete="new-password" placeholder={t.auth.newPasswordPlaceholder} />
        </Form.Item>
        <Form.Item
          name="confirmPassword"
          label={t.auth.confirmPassword}
          dependencies={['newPassword']}
          rules={[
            ({ getFieldValue }) => ({
              validator: (_, v) =>
                (v || '') === (getFieldValue('newPassword') || '') ? Promise.resolve() : Promise.reject(new Error(t.auth.passwordMismatch)),
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" placeholder={t.auth.confirmPlaceholder} />
        </Form.Item>
        {/* 输入框里按回车直接保存 */}
        <button type="submit" hidden />
      </Form>
    </Modal>
  );
}
