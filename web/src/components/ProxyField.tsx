import { Flex, Form, Select } from 'antd';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useProxyOptions } from '../hooks/data';
import { tip } from '../lib/form';
import { t } from '../i18n';

/** 表单里的「代理选择」：不选表示直连，后面跟着去管理代理的入口 */
export function ProxyField({ help }: { help: ReactNode }) {
  const options = useProxyOptions();
  return (
    <Form.Item label={t.accounts.proxy} tooltip={tip(help)}>
      <Flex gap={12} align="center">
        {/* 清空时传 null，表示改回直连 */}
        <Form.Item name="proxyId" noStyle normalize={(v?: number | null) => v ?? null}>
          <Select allowClear placeholder={t.accounts.direct} options={options} />
        </Form.Item>
        <Link to="/settings/proxies" style={{ flex: 'none' }}>
          {t.accounts.manageProxies}
        </Link>
      </Flex>
    </Form.Item>
  );
}
