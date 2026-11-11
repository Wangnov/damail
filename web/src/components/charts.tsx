import { Flex, Typography, theme } from 'antd';
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EmptyBlock } from './EmptyBlock';
import { t } from '../i18n';

/**
 * 轻量图表：柱状图、横向条形列表、热力图、指标卡。
 * 颜色取自经过色觉障碍校验的分类色板（浅色 / 深色各一套），文字一律用文本色，不用系列色。
 */

const LIGHT = { s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', ramp: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'] };
const DARK = { s1: '#3987e5', s2: '#d95926', s3: '#199e70', ramp: ['#1d2a3a', '#184f95', '#1c5cab', '#256abf', '#3987e5', '#6da7ec'] };

export function useChartColors() {
  const { token } = theme.useToken();
  // 深色算法下背景基色是黑色
  const dark = token.colorBgBase === '#000' || token.colorBgBase === '#000000';
  return { ...(dark ? DARK : LIGHT), dark, token };
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceMax(v: number) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

export function Legend({ items }: { items: Array<{ name: string; color: string }> }) {
  return (
    <Flex gap={14} wrap style={{ fontSize: 12 }}>
      {items.map((s) => (
        <Flex key={s.name} align="center" gap={6}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, display: 'inline-block' }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {s.name}
          </Typography.Text>
        </Flex>
      ))}
    </Flex>
  );
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const { token } = theme.useToken();
  const left = Math.min(Math.max(x, 70), width - 70);
  return (
    <div
      style={{
        position: 'absolute',
        left,
        top: y,
        transform: 'translate(-50%, calc(-100% - 8px))',
        background: token.colorBgElevated,
        boxShadow: token.boxShadowSecondary,
        borderRadius: 6,
        padding: '6px 10px',
        fontSize: 12,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        zIndex: 2,
      }}
    >
      {children}
    </div>
  );
}

export type ColumnDatum = { label: string; hint?: string; values: number[] };

/** 分组柱状图：一个 x 一组柱子，悬停显示该组的所有数值 */
export function ColumnChart({ data, series, height = 200 }: { data: ColumnDatum[]; series: Array<{ name: string; color: string }>; height?: number }) {
  const { token } = useChartColors();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { top: 8, right: 4, bottom: 22, left: 32 };
  const max = niceMax(Math.max(1, ...data.flatMap((d) => d.values)));
  const ticks = [0, max / 2, max];
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const band = data.length ? plotW / data.length : 0;
  const groupW = Math.min(band * 0.72, 18 * series.length + 2 * (series.length - 1));
  const barW = series.length ? (groupW - 2 * (series.length - 1)) / series.length : 0;
  // x 轴标签太密时隔几个显示一个
  const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 44))));
  const y = (v: number) => pad.top + plotH - (v / max) * plotH;

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      {series.length > 1 && (
        <div style={{ marginBottom: 8 }}>
          <Legend items={series} />
        </div>
      )}
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={series.map((s) => s.name).join('、')} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke={token.colorSplit} strokeWidth={1} />
              <text x={pad.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={token.colorTextTertiary}>
                {t}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x0 = pad.left + i * band + (band - groupW) / 2;
            return (
              <g key={d.label}>
                {hover === i && <rect x={pad.left + i * band} y={pad.top} width={band} height={plotH} fill={token.colorFillQuaternary} />}
                {d.values.map((v, k) => {
                  const h = Math.max(0, (v / max) * plotH);
                  const x = x0 + k * (barW + 2);
                  const r = Math.min(4, barW / 2, h);
                  // 只圆角顶端，底部贴着基线
                  return v > 0 ? (
                    <path
                      key={k}
                      d={`M${x},${y(0)} V${y(v) + r} Q${x},${y(v)} ${x + r},${y(v)} H${x + barW - r} Q${x + barW},${y(v)} ${x + barW},${y(v) + r} V${y(0)} Z`}
                      fill={series[k]!.color}
                    />
                  ) : null;
                })}
                {i % every === 0 && (
                  <text x={pad.left + i * band + band / 2} y={height - 6} textAnchor="middle" fontSize={11} fill={token.colorTextTertiary}>
                    {d.label}
                  </text>
                )}
                {/* 整列都是悬停热区，比柱子本身大 */}
                <rect x={pad.left + i * band} y={pad.top} width={band} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && data[hover] && (
        <Tooltip x={pad.left + hover * band + band / 2} y={y(Math.max(...data[hover].values)) + (series.length > 1 ? 30 : 0)} width={width}>
          <div style={{ color: token.colorTextSecondary, marginBottom: 2 }}>{data[hover].hint ?? data[hover].label}</div>
          {series.map((s, k) => (
            <Flex key={s.name} align="center" gap={6}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
              <span style={{ color: token.colorText }}>
                {s.name} <b>{data[hover]!.values[k]}</b>
              </span>
            </Flex>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

export type BarItem = { key: string; label: ReactNode; value: number; hint?: string; onClick?: () => void };

/** 横向条形列表：标签 + 条 + 数值，适合分类、发件人这类排名 */
export function BarList({ items, color, total, empty }: { items: BarItem[]; color?: string; total?: number; empty?: string }) {
  const c = useChartColors();
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <EmptyBlock description={empty ?? t.dashboard.noData} minHeight={120} />;
  return (
    <Flex vertical gap={8}>
      {items.map((i) => (
        <div
          key={i.key}
          title={i.hint}
          onClick={i.onClick}
          style={{ cursor: i.onClick ? 'pointer' : undefined, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 10, rowGap: 3 }}
        >
          <Typography.Text ellipsis style={{ fontSize: 13 }}>
            {i.label}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            {i.value}
            {total ? ` · ${Math.round((i.value / total) * 100)}%` : ''}
          </Typography.Text>
          <div style={{ gridColumn: '1 / -1', height: 6, borderRadius: 3, background: c.token.colorFillTertiary }}>
            <div style={{ width: `${(i.value / max) * 100}%`, minWidth: i.value ? 4 : 0, height: '100%', borderRadius: 3, background: color ?? c.s1 }} />
          </div>
        </div>
      ))}
    </Flex>
  );
}

/** 热力图：行 × 列的格子，单色由浅到深表示数量 */
export function Heatmap({
  rows,
  cols,
  values,
  format,
}: {
  rows: string[];
  cols: string[];
  values: number[][];
  format: (r: number, c: number, v: number) => string;
}) {
  const c = useChartColors();
  const max = Math.max(1, ...values.flat());
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const colorOf = (v: number) => (v === 0 ? c.token.colorFillQuaternary : c.ramp[Math.min(c.ramp.length - 1, Math.floor((v / max) * (c.ramp.length - 0.001)))]);
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: `28px repeat(${cols.length}, minmax(0, 1fr))`, gap: 2, alignItems: 'center' }}>
        <span />
        {cols.map((col, i) => (
          <Typography.Text key={col} type="secondary" style={{ fontSize: 10, textAlign: 'center', visibility: i % 3 === 0 ? 'visible' : 'hidden' }}>
            {col}
          </Typography.Text>
        ))}
        {rows.map((row, r) => (
          <FragmentRow key={row}>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {row}
            </Typography.Text>
            {cols.map((col, k) => (
              <div
                key={col}
                onMouseEnter={() => setHover({ r, c: k })}
                onMouseLeave={() => setHover(null)}
                style={{
                  height: 16,
                  borderRadius: 3,
                  background: colorOf(values[r]![k]!),
                  outline: hover?.r === r && hover?.c === k ? `2px solid ${c.token.colorText}` : undefined,
                }}
              />
            ))}
          </FragmentRow>
        ))}
      </div>
      <Flex justify="space-between" align="center" style={{ marginTop: 8, minHeight: 20 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hover ? format(hover.r, hover.c, values[hover.r]![hover.c]!) : t.dashboard.hoverHint}
        </Typography.Text>
        <Flex align="center" gap={4}>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {t.dashboard.less}
          </Typography.Text>
          {[c.token.colorFillQuaternary, ...c.ramp].map((col) => (
            <span key={col} style={{ width: 12, height: 12, borderRadius: 2, background: col }} />
          ))}
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {t.dashboard.moreLabel}
          </Typography.Text>
        </Flex>
      </Flex>
    </div>
  );
}

function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** 指标卡：大数字 + 与上一周期的变化 */
export function StatTile({
  title,
  value,
  prev,
  suffix,
  hint,
  format = (v) => v.toLocaleString('zh-CN'),
}: {
  title: string;
  value: number;
  prev?: number;
  suffix?: string;
  hint?: string;
  format?: (v: number) => string;
}) {
  const { token } = theme.useToken();
  const delta = useMemo(() => {
    if (prev === undefined) return null;
    const diff = value - prev;
    if (diff === 0) return { text: t.dashboard.flat, color: token.colorTextTertiary };
    const pct = prev > 0 ? `${Math.round((Math.abs(diff) / prev) * 100)}%` : '';
    return { text: `${diff > 0 ? '↑' : '↓'} ${format(Math.abs(diff))}${pct ? t.dashboard.pct(pct) : ''}`, color: token.colorTextSecondary };
  }, [value, prev, token, format]);
  return (
    <div title={hint} style={{ padding: '12px 16px', border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadiusLG, minWidth: 0 }}>
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        {title}
      </Typography.Text>
      <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.3, fontVariantNumeric: 'tabular-nums', color: token.colorText }}>
        {format(value)}
        {suffix && <span style={{ fontSize: 14, fontWeight: 400, marginLeft: 2 }}>{suffix}</span>}
      </div>
      {delta && <div style={{ fontSize: 12, color: delta.color }}>{delta.text}</div>}
    </div>
  );
}
