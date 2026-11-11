import { BgColorsOutlined, CheckOutlined } from '@ant-design/icons';
import { Button, ColorPicker, Flex, Segmented, Switch, Tag } from 'antd';
import type { CSSProperties } from 'react';
import {
  ACCENTS,
  BORDER_KEYS,
  DEFAULT_ACCENT,
  RADIUS,
  SIZE_KEYS,
  accentLabel,
  setAccent,
  setBorder,
  setComponentSize,
  setGlass,
  setMotion,
  setRadius,
  setThemeMode,
  useAccent,
  useBorder,
  useComponentSize,
  useGlass,
  useMotion,
  useRadius,
  useThemeMode,
  type BorderKey,
  type RadiusKey,
  type SizeKey,
  type ThemeMode,
} from '../../lib/theme';
import { SettingsPage } from '../../components/SettingsPage';
import { t } from '../../i18n';

const MODES: ThemeMode[] = ['system', 'light', 'dark'];

/** 模式卡片里的小缩略图：浅灰外壳 + 内容卡片 + 一条主题色，跟随系统是左浅右深 */
function ModeThumb({ mode }: { mode: ThemeMode }) {
  return (
    <span className={`mode-thumb ${mode}`} aria-hidden>
      <span className="mode-thumb-half light">
        <i />
        <b />
      </span>
      <span className="mode-thumb-half dark">
        <i />
        <b />
      </span>
    </span>
  );
}

/** 基础设置 · 外观：明暗模式、主题色、组件大小、圆角、边框，选了立即生效，保存在本机浏览器 */
export function AppearancePage() {
  const mode = useThemeMode();
  const accent = useAccent();
  const radius = useRadius();
  const border = useBorder();
  const size = useComponentSize();
  const glass = useGlass();
  const motion = useMotion();
  const custom = !ACCENTS.some((a) => a.color === accent);
  const changed = accent !== DEFAULT_ACCENT || mode !== 'system' || radius !== 'medium' || border !== 'normal' || size !== 'middle' || !glass || !motion;

  return (
    <SettingsPage title={t.appearance.title} description={t.appearance.description}>
      <div className="appearance-page">
        <div className="appearance-label">{t.appearance.mode}</div>
        <div className="appearance-modes" role="radiogroup" aria-label={t.appearance.mode}>
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={m === mode}
              className={`appearance-mode${m === mode ? ' on' : ''}`}
              onClick={() => setThemeMode(m)}
            >
              <ModeThumb mode={m} />
              <span>{t.appearance.modes[m]}</span>
            </button>
          ))}
        </div>

        <Flex align="baseline" justify="space-between" className="appearance-label">
          <span>{t.appearance.accent}</span>
          <span className="appearance-current">{accentLabel(accent)}</span>
        </Flex>
        <div className="accent-swatches" role="radiogroup" aria-label={t.appearance.accent}>
          {ACCENTS.map((a) => (
            <button
              key={a.key}
              type="button"
              role="radio"
              aria-checked={a.color === accent}
              aria-label={t.appearance.accents[a.key]}
              title={t.appearance.accents[a.key]}
              className={`accent-swatch${a.color === accent ? ' on' : ''}`}
              style={{ '--swatch': a.color } as CSSProperties}
              onClick={() => setAccent(a.color)}
            >
              {a.color === accent && <CheckOutlined />}
            </button>
          ))}
          <ColorPicker value={accent} disabledAlpha onChangeComplete={(c) => setAccent(c.toHexString())}>
            <button
              type="button"
              aria-label={t.appearance.customColorPick}
              title={t.appearance.customColorPick}
              className={`accent-swatch custom${custom ? ' on' : ''}`}
              style={custom ? ({ '--swatch': accent } as CSSProperties) : undefined}
            >
              {custom ? <CheckOutlined /> : <BgColorsOutlined />}
            </button>
          </ColorPicker>
        </div>

        <div className="appearance-rows">
          <div className="appearance-row">
            <span>{t.appearance.componentSize}</span>
            <Segmented<SizeKey> value={size} onChange={setComponentSize} options={SIZE_KEYS.map((k) => ({ value: k, label: t.appearance.size[k] }))} />
          </div>
          <div className="appearance-row">
            <span>{t.appearance.radiusLabel}</span>
            <Segmented<RadiusKey>
              value={radius}
              onChange={setRadius}
              options={(Object.keys(RADIUS) as RadiusKey[]).map((k) => ({ value: k, label: t.appearance.radius[k] }))}
            />
          </div>
          <div className="appearance-row">
            <span>{t.appearance.borderLabel}</span>
            <Segmented<BorderKey> value={border} onChange={setBorder} options={BORDER_KEYS.map((k) => ({ value: k, label: t.appearance.border[k] }))} />
          </div>
          <div className="appearance-row">
            <span>
              {t.appearance.glass}
              <span className="appearance-row-hint">{t.appearance.glassHint}</span>
            </span>
            <Switch checked={glass} onChange={setGlass} aria-label={t.appearance.glass} />
          </div>
          <div className="appearance-row">
            <span>
              {t.appearance.motion}
              <span className="appearance-row-hint">{t.appearance.motionHint}</span>
            </span>
            <Switch checked={motion} onChange={setMotion} aria-label={t.appearance.motion} />
          </div>
        </div>

        {/* 预览：主题色、圆角、边框在按钮、开关、链接、标签上的样子 */}
        <div className="appearance-preview">
          <Button type="primary">{t.appearance.previewPrimary}</Button>
          <Button>{t.appearance.previewDefault}</Button>
          <Switch defaultChecked />
          <Tag color="processing" style={{ marginInlineEnd: 0 }}>
            {t.appearance.previewTag}
          </Tag>
          <a>{t.appearance.previewLink}</a>
        </div>

        <Flex align="center" justify="space-between" className="pref-hint">
          <span>{t.appearance.localOnly}</span>
          {changed && (
            <a
              onClick={() => {
                setAccent(DEFAULT_ACCENT);
                setThemeMode('system');
                setRadius('medium');
                setBorder('normal');
                setComponentSize('middle');
                setGlass(true);
                setMotion(true);
              }}
            >
              {t.appearance.reset}
            </a>
          )}
        </Flex>
      </div>
    </SettingsPage>
  );
}
