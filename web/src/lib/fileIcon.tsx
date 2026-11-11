import {
  FileExcelOutlined,
  FileGifOutlined,
  FileImageOutlined,
  FileJpgOutlined,
  FileMarkdownOutlined,
  FileOutlined,
  FilePdfOutlined,
  FilePptOutlined,
  FileTextOutlined,
  FileWordOutlined,
  FileZipOutlined,
} from '@ant-design/icons';
import type { ComponentType, CSSProperties } from 'react';

type Kind = { icon: ComponentType<{ style?: CSSProperties }>; color: string };

// 颜色沿用各类文件常见的品牌色：PDF 红、Word 蓝、Excel 绿、PPT 橙
const KINDS = {
  pdf: { icon: FilePdfOutlined, color: '#e5484d' },
  word: { icon: FileWordOutlined, color: '#2b6cdf' },
  excel: { icon: FileExcelOutlined, color: '#1f9d55' },
  ppt: { icon: FilePptOutlined, color: '#e8590c' },
  jpg: { icon: FileJpgOutlined, color: '#7c5cdb' },
  gif: { icon: FileGifOutlined, color: '#7c5cdb' },
  image: { icon: FileImageOutlined, color: '#7c5cdb' },
  zip: { icon: FileZipOutlined, color: '#b7791f' },
  markdown: { icon: FileMarkdownOutlined, color: 'var(--ant-color-text-secondary)' },
  text: { icon: FileTextOutlined, color: 'var(--ant-color-text-secondary)' },
  other: { icon: FileOutlined, color: 'var(--ant-color-text-secondary)' },
} satisfies Record<string, Kind>;

const BY_EXT: Record<string, keyof typeof KINDS> = {
  pdf: 'pdf',
  doc: 'word',
  docx: 'word',
  rtf: 'word',
  odt: 'word',
  pages: 'word',
  xls: 'excel',
  xlsx: 'excel',
  xlsm: 'excel',
  csv: 'excel',
  ods: 'excel',
  numbers: 'excel',
  ppt: 'ppt',
  pptx: 'ppt',
  odp: 'ppt',
  key: 'ppt',
  jpg: 'jpg',
  jpeg: 'jpg',
  gif: 'gif',
  png: 'image',
  webp: 'image',
  heic: 'image',
  bmp: 'image',
  svg: 'image',
  tif: 'image',
  tiff: 'image',
  zip: 'zip',
  rar: 'zip',
  '7z': 'zip',
  gz: 'zip',
  tgz: 'zip',
  tar: 'zip',
  bz2: 'zip',
  xz: 'zip',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  log: 'text',
  json: 'text',
  xml: 'text',
  html: 'text',
  htm: 'text',
  eml: 'text',
  ics: 'text',
};

/** 按扩展名判断，没有扩展名时退回到 MIME 类型（邮件附件的 MIME 类型经常是 application/octet-stream） */
function kindOf(filename: string | null | undefined, contentType?: string | null): keyof typeof KINDS {
  const ext = filename?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (ext && BY_EXT[ext]) return BY_EXT[ext];
  const type = (contentType ?? '').toLowerCase();
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('image/')) return type === 'image/gif' ? 'gif' : type === 'image/jpeg' ? 'jpg' : 'image';
  if (/wordprocessing|msword/.test(type)) return 'word';
  if (/spreadsheet|ms-excel|text\/csv/.test(type)) return 'excel';
  if (/presentation|ms-powerpoint/.test(type)) return 'ppt';
  if (/zip|compressed|x-tar|gzip|x-7z|x-rar/.test(type)) return 'zip';
  if (type === 'text/markdown') return 'markdown';
  if (type.startsWith('text/')) return 'text';
  return 'other';
}

/** 附件图标：PDF、Word、Excel、图片、压缩包等各用对应的图标和颜色 */
export function FileIcon({ filename, contentType, style }: { filename: string | null | undefined; contentType?: string | null; style?: CSSProperties }) {
  const { icon: Icon, color } = KINDS[kindOf(filename, contentType)];
  return <Icon style={{ color, ...style }} />;
}
