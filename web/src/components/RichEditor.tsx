import {
  AlignCenterOutlined,
  AlignLeftOutlined,
  AlignRightOutlined,
  BgColorsOutlined,
  BoldOutlined,
  ClearOutlined,
  CodeOutlined,
  DisconnectOutlined,
  FontColorsOutlined,
  FontSizeOutlined,
  ItalicOutlined,
  LinkOutlined,
  OrderedListOutlined,
  PictureOutlined,
  RedoOutlined,
  StrikethroughOutlined,
  TableOutlined,
  UnderlineOutlined,
  UndoOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { Color, FontSize, TextStyle } from '@tiptap/extension-text-style';
import { Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { App, Button, Divider, Dropdown, Flex, Input, Popover, Tooltip, theme } from 'antd';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { imageToDataUrl, isImageFile } from '../lib/inlineImage';

type Props = {
  /** HTML 正文 */
  value?: string;
  onChange?: (html: string) => void;
  /** 每次修改时同时给出纯文本版本，用作邮件的 text/plain 部分 */
  onTextChange?: (text: string) => void;
  editable?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** 无边框：写信抽屉里铺满剩余空间，工具栏吸顶 */
  bare?: boolean;
  /** 提供时工具栏多一个「HTML 源码」按钮 */
  onSourceMode?: () => void;
};

/** 纯文本正文（Agent / 规则生成的草稿）转成编辑器可用的段落 */
export function textToHtml(text: string) {
  if (!text) return '';
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
  return text
    .split(/\r?\n\r?\n/)
    .map((p) => `<p>${esc(p).replace(/\r?\n/g, '<br>')}</p>`)
    .join('');
}

/** 列表项带上序号 / 圆点，引用加上 >，让纯文本版本读起来接近富文本 */
export function editorText(editor: Editor) {
  const lines: string[] = [];
  editor.state.doc.forEach((node) => {
    const walk = (n: typeof node, prefix: string, depth: number) => {
      if (n.type.name === 'bulletList' || n.type.name === 'orderedList') {
        let i = n.type.name === 'orderedList' ? ((n.attrs.start as number) ?? 1) : 0;
        n.forEach((item) => {
          const marker = n.type.name === 'orderedList' ? `${i++}. ` : '• ';
          item.forEach((child, _o, idx) => walk(child, `${prefix}${'  '.repeat(depth)}${idx === 0 ? marker : '   '}`, depth + 1));
        });
      } else if (n.type.name === 'blockquote') {
        n.forEach((child) => walk(child, `${prefix}> `, depth));
      } else if (n.type.name === 'horizontalRule') {
        lines.push('----------');
      } else {
        const text = n.textBetween(0, n.content.size, '\n', (leaf) => (leaf.type.name === 'hardBreak' ? '\n' : ''));
        lines.push(...text.split('\n').map((l) => prefix + l));
      }
    };
    walk(node, '', 0);
    if (node.type.name === 'paragraph' || node.type.name === 'heading') lines.push('');
  });
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ToolButton({
  title,
  active,
  onClick,
  children,
  disabled,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Tooltip title={title} mouseEnterDelay={0.6}>
      <Button
        size="small"
        color={active ? 'primary' : 'default'}
        variant={active ? 'filled' : 'text'}
        icon={children}
        aria-label={title}
        aria-pressed={active}
        disabled={disabled}
        // 不让按钮抢走编辑器焦点，否则选区会丢失
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
      />
    </Tooltip>
  );
}

function LinkButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const active = editor.isActive('link');
  const apply = () => {
    const href = url.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!href) chain.unsetLink().run();
    else chain.setLink({ href: /^(https?:|mailto:)/i.test(href) ? href : `https://${href}` }).run();
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setUrl((editor.getAttributes('link').href as string | undefined) ?? '');
      }}
      trigger="click"
      content={
        <Flex gap={6}>
          <Input
            size="small"
            autoFocus
            placeholder="https://"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onPressEnter={apply}
            style={{ width: 240 }}
          />
          <Button size="small" type="primary" onClick={apply}>
            {t.editor.ok}
          </Button>
        </Flex>
      }
    >
      <Tooltip title={t.editor.insertLink} mouseEnterDelay={0.6}>
        <Button
          size="small"
          color={active ? 'primary' : 'default'}
          variant={active ? 'filled' : 'text'}
          icon={<LinkOutlined />}
          aria-label={t.editor.insertLink}
        />
      </Tooltip>
    </Popover>
  );
}

// 文字颜色和背景高亮的色板
const TEXT_COLORS = ['#1f1f1f', '#595959', '#8c8c8c', '#cf1322', '#d46b08', '#d4b106', '#389e0d', '#08979c', '#0958d9', '#531dab', '#c41d7f'];
const HIGHLIGHTS = ['#fff1b8', '#ffd8bf', '#ffccc7', '#d9f7be', '#b5f5ec', '#bae0ff', '#efdbff', '#f0f0f0'];
const FONT_SIZES = [
  { key: '12px', label: () => t.editor.sizes.small },
  { key: '', label: () => t.editor.sizes.normal },
  { key: '18px', label: () => t.editor.sizes.large },
  { key: '24px', label: () => t.editor.sizes.huge },
];

function Swatches({ colors, value, onPick, clearLabel }: { colors: string[]; value?: string; onPick: (c: string | null) => void; clearLabel: string }) {
  return (
    <div className="editor-swatches">
      <button type="button" className="editor-swatch-clear" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(null)}>
        {clearLabel}
      </button>
      <div className="editor-swatch-grid">
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            className={`editor-swatch${value?.toLowerCase() === c ? ' on' : ''}`}
            style={{ background: c }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(c)}
          />
        ))}
      </div>
    </div>
  );
}

function ColorButton({
  title,
  icon,
  bar,
  colors,
  value,
  onPick,
  clearLabel,
}: {
  title: string;
  icon: ReactNode;
  bar?: string;
  colors: string[];
  value?: string;
  onPick: (c: string | null) => void;
  clearLabel: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottom"
      content={
        <Swatches
          colors={colors}
          value={value}
          clearLabel={clearLabel}
          onPick={(c) => {
            onPick(c);
            setOpen(false);
          }}
        />
      }
    >
      <Tooltip title={title} mouseEnterDelay={0.6}>
        <Button
          size="small"
          type="text"
          aria-label={title}
          className="editor-color-btn"
          onMouseDown={(e) => e.preventDefault()}
          icon={
            <span className="editor-color-icon">
              {icon}
              <i style={{ background: bar ?? 'transparent' }} />
            </span>
          }
        />
      </Tooltip>
    </Popover>
  );
}

function Toolbar({ editor, onSourceMode }: { editor: Editor; onSourceMode?: () => void }) {
  const { message } = App.useApp();
  const fileInput = useRef<HTMLInputElement>(null);
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      h: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      link: e.isActive('link'),
      table: e.isActive('table'),
      color: e.getAttributes('textStyle').color as string | undefined,
      fontSize: (e.getAttributes('textStyle').fontSize as string | undefined) ?? '',
      highlight: e.getAttributes('highlight').color as string | undefined,
      align: (['center', 'right'] as const).find((a) => e.isActive({ textAlign: a })) ?? 'left',
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const run = (fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => () => fn(editor.chain().focus()).run();
  const alignIcon = s.align === 'center' ? <AlignCenterOutlined /> : s.align === 'right' ? <AlignRightOutlined /> : <AlignLeftOutlined />;

  const insertImages = async (files: File[]) => {
    for (const f of files.filter(isImageFile)) {
      try {
        editor
          .chain()
          .focus()
          .setImage({ src: await imageToDataUrl(f), alt: f.name })
          .run();
      } catch {
        message.error(t.editor.imageTooLarge(f.name));
      }
    }
  };

  return (
    <Flex wrap align="center" gap={2} style={{ padding: '4px 6px' }}>
      <Dropdown
        trigger={['click']}
        menu={{
          selectable: true,
          selectedKeys: [s.fontSize],
          items: FONT_SIZES.map((f) => ({ key: f.key || 'normal', label: <span style={f.key ? { fontSize: f.key } : undefined}>{f.label()}</span> })),
          onClick: ({ key }) => (key === 'normal' ? run((c) => c.unsetFontSize())() : run((c) => c.setFontSize(key))()),
        }}
      >
        <Tooltip title={t.editor.fontSize} mouseEnterDelay={0.6}>
          <Button size="small" type="text" icon={<FontSizeOutlined />} aria-label={t.editor.fontSize} onMouseDown={(e) => e.preventDefault()} />
        </Tooltip>
      </Dropdown>
      <ToolButton title={t.editor.bold} active={s.bold} onClick={run((c) => c.toggleBold())}>
        <BoldOutlined />
      </ToolButton>
      <ToolButton title={t.editor.italic} active={s.italic} onClick={run((c) => c.toggleItalic())}>
        <ItalicOutlined />
      </ToolButton>
      <ToolButton title={t.editor.underline} active={s.underline} onClick={run((c) => c.toggleUnderline())}>
        <UnderlineOutlined />
      </ToolButton>
      <ToolButton title={t.editor.strike} active={s.strike} onClick={run((c) => c.toggleStrike())}>
        <StrikethroughOutlined />
      </ToolButton>
      <ColorButton
        title={t.editor.textColor}
        icon={<FontColorsOutlined />}
        bar={s.color ?? 'currentColor'}
        colors={TEXT_COLORS}
        value={s.color}
        clearLabel={t.editor.defaultColor}
        onPick={(c) => (c ? run((x) => x.setColor(c))() : run((x) => x.unsetColor())())}
      />
      <ColorButton
        title={t.editor.highlight}
        icon={<BgColorsOutlined />}
        bar={s.highlight}
        colors={HIGHLIGHTS}
        value={s.highlight}
        clearLabel={t.editor.noHighlight}
        onPick={(c) => (c ? run((x) => x.setHighlight({ color: c }))() : run((x) => x.unsetHighlight())())}
      />
      <Divider orientation="vertical" style={{ marginInline: 4 }} />
      <ToolButton title={t.editor.heading} active={s.h} onClick={run((c) => c.toggleHeading({ level: 3 }))}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>H</span>
      </ToolButton>
      <Dropdown
        trigger={['click']}
        menu={{
          selectable: true,
          selectedKeys: [s.align],
          items: [
            { key: 'left', icon: <AlignLeftOutlined />, label: t.editor.alignLeft },
            { key: 'center', icon: <AlignCenterOutlined />, label: t.editor.alignCenter },
            { key: 'right', icon: <AlignRightOutlined />, label: t.editor.alignRight },
          ],
          onClick: ({ key }) => run((c) => (key === 'left' ? c.unsetTextAlign() : c.setTextAlign(key)))(),
        }}
      >
        <Tooltip title={t.editor.align} mouseEnterDelay={0.6}>
          <Button size="small" type="text" icon={alignIcon} aria-label={t.editor.align} onMouseDown={(e) => e.preventDefault()} />
        </Tooltip>
      </Dropdown>
      <ToolButton title={t.editor.bullet} active={s.bullet} onClick={run((c) => c.toggleBulletList())}>
        <UnorderedListOutlined />
      </ToolButton>
      <ToolButton title={t.editor.ordered} active={s.ordered} onClick={run((c) => c.toggleOrderedList())}>
        <OrderedListOutlined />
      </ToolButton>
      <ToolButton title={t.editor.quote} active={s.quote} onClick={run((c) => c.toggleBlockquote())}>
        <span style={{ fontWeight: 700, fontSize: 15, lineHeight: 1 }}>“</span>
      </ToolButton>
      <Divider orientation="vertical" style={{ marginInline: 4 }} />
      <LinkButton editor={editor} />
      {s.link && (
        <ToolButton title={t.editor.unlink} onClick={run((c) => c.extendMarkRange('link').unsetLink())}>
          <DisconnectOutlined />
        </ToolButton>
      )}
      <ToolButton title={t.editor.image} onClick={() => fileInput.current?.click()}>
        <PictureOutlined />
      </ToolButton>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          void insertImages(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      {s.table ? (
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'rowBefore', label: t.editor.table.rowBefore },
              { key: 'rowAfter', label: t.editor.table.rowAfter },
              { key: 'colBefore', label: t.editor.table.colBefore },
              { key: 'colAfter', label: t.editor.table.colAfter },
              { type: 'divider' },
              { key: 'header', label: t.editor.table.toggleHeader },
              { key: 'merge', label: t.editor.table.mergeOrSplit },
              { type: 'divider' },
              { key: 'delRow', label: t.editor.table.deleteRow, danger: true },
              { key: 'delCol', label: t.editor.table.deleteCol, danger: true },
              { key: 'delTable', label: t.editor.table.deleteTable, danger: true },
            ],
            onClick: ({ key }) =>
              run((c) => {
                switch (key) {
                  case 'rowBefore':
                    return c.addRowBefore();
                  case 'rowAfter':
                    return c.addRowAfter();
                  case 'colBefore':
                    return c.addColumnBefore();
                  case 'colAfter':
                    return c.addColumnAfter();
                  case 'header':
                    return c.toggleHeaderRow();
                  case 'merge':
                    return c.mergeOrSplit();
                  case 'delRow':
                    return c.deleteRow();
                  case 'delCol':
                    return c.deleteColumn();
                  default:
                    return c.deleteTable();
                }
              })(),
          }}
        >
          <Tooltip title={t.editor.table.edit} mouseEnterDelay={0.6}>
            <Button
              size="small"
              color="primary"
              variant="filled"
              icon={<TableOutlined />}
              aria-label={t.editor.table.edit}
              onMouseDown={(e) => e.preventDefault()}
            />
          </Tooltip>
        </Dropdown>
      ) : (
        <ToolButton title={t.editor.table.insert} onClick={run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))}>
          <TableOutlined />
        </ToolButton>
      )}
      <ToolButton title={t.editor.clear} onClick={run((c) => c.unsetAllMarks().clearNodes().unsetTextAlign())}>
        <ClearOutlined />
      </ToolButton>
      <Divider orientation="vertical" style={{ marginInline: 4 }} />
      <ToolButton title={t.editor.undo} disabled={!s.canUndo} onClick={run((c) => c.undo())}>
        <UndoOutlined />
      </ToolButton>
      <ToolButton title={t.editor.redo} disabled={!s.canRedo} onClick={run((c) => c.redo())}>
        <RedoOutlined />
      </ToolButton>
      {onSourceMode && (
        <Tooltip title={t.editor.sourceTip} mouseEnterDelay={0.6}>
          <Button size="small" type="text" className="editor-source-btn" icon={<CodeOutlined />} onMouseDown={(e) => e.preventDefault()} onClick={onSourceMode}>
            HTML
          </Button>
        </Tooltip>
      )}
    </Flex>
  );
}

/** 写信用的富文本编辑器，输出受 schema 约束的简单 HTML（段落、列表、引用、链接、基本样式） */
export function RichEditor({ value, onChange, onTextChange, editable = true, placeholder, autoFocus, bare, onSourceMode }: Props) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const onImageError = (name: string) => void message.error(t.editor.imageTooLarge(name));
  const handlers = useRef({ onChange, onTextChange, onImageError });
  handlers.current = { onChange, onTextChange, onImageError };
  // 编辑器初始化时会规范化内容（例如补尾段落），这不算用户修改，否则打开待审批草稿就会被悄悄改写
  const userTouched = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [3] },
        code: false,
        codeBlock: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      }),
      Placeholder.configure({ placeholder: placeholder ?? '' }),
      TextStyle,
      Color,
      FontSize,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      // 图片存成 data: 地址，发送时服务端转成内嵌附件
      Image.configure({ allowBase64: true }),
      TableKit.configure({ table: { resizable: false } }),
    ],
    editorProps: {
      // 粘贴、拖进来的图片插到正文里
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter(isImageFile);
        if (!files.length) return false;
        void (async () => {
          for (const f of files) {
            try {
              const src = await imageToDataUrl(f);
              const node = view.state.schema.nodes.image!.create({ src, alt: f.name });
              view.dispatch(view.state.tr.replaceSelectionWith(node));
            } catch {
              handlers.current.onImageError?.(f.name);
            }
          }
        })();
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (moved || !files.length || !files.every(isImageFile)) return false;
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
        event.preventDefault();
        void (async () => {
          let at = pos;
          for (const f of files) {
            try {
              const src = await imageToDataUrl(f);
              const node = view.state.schema.nodes.image!.create({ src, alt: f.name });
              view.dispatch(view.state.tr.insert(at, node));
              at += node.nodeSize;
            } catch {
              handlers.current.onImageError?.(f.name);
            }
          }
        })();
        return true;
      },
    },
    content: value ?? '',
    editable,
    autofocus: autoFocus ? 'start' : false,
    shouldRerenderOnTransaction: false,
    onFocus: () => {
      userTouched.current = true;
    },
    onUpdate: ({ editor: e }) => {
      if (!userTouched.current) return;
      handlers.current.onTextChange?.(editorText(e));
      handlers.current.onChange?.(e.isEmpty ? '' : e.getHTML());
    },
  });

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  if (bare) {
    return (
      <div className="rich-editor rich-editor-bare">
        {editor && editable && (
          <div className="rich-editor-toolbar">
            <Toolbar editor={editor} onSourceMode={onSourceMode} />
          </div>
        )}
        <EditorContent editor={editor} className="rich-editor-content" />
      </div>
    );
  }

  return (
    <div
      className="rich-editor"
      style={{
        border: `1px solid ${token.colorBorder}`,
        borderRadius: token.borderRadius,
        background: editable ? token.colorBgContainer : token.colorBgContainerDisabled,
      }}
    >
      {editor && editable && (
        <div style={{ borderBottom: `1px solid ${token.colorSplit}` }}>
          <Toolbar editor={editor} onSourceMode={onSourceMode} />
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
