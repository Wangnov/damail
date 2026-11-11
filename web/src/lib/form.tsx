import { ExclamationCircleOutlined } from '@ant-design/icons';
import type { FormProps } from 'antd';
import type { CSSProperties, ReactNode } from 'react';

/**
 * 统一的表单布局：左边 label、右边输入框，窄屏（< 576px）退回上下排。
 * labelWidth 默认能放下 5 个汉字，label 更长的表单按最长的 label 加宽；没有 label 的项（勾选框、提示等）加 className="form-offset" 跟输入框对齐
 */
export function horizontalForm(labelWidth = 96, style?: CSSProperties) {
  return {
    layout: 'horizontal',
    labelCol: { xs: { span: 24 }, sm: { flex: `${labelWidth}px` } },
    wrapperCol: { xs: { span: 24 }, sm: { flex: '1' } },
    labelWrap: true,
    colon: false,
    style: { ...style, '--form-label-width': `${labelWidth}px` } as CSSProperties,
  } satisfies FormProps;
}

/** 表单项的说明：label 后面一个感叹号，悬停显示，用在 Form.Item 的 tooltip 上 */
export const tip = (title: ReactNode) => ({ title, icon: <ExclamationCircleOutlined /> });
