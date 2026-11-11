import { useQuery } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import { useContext, useState } from 'react';
import { t } from '../i18n';

/**
 * IP 归属地：在浏览器里直接查 ipwho.is，只在用户点击后查询；按当前界面语言返回中文或英文地名。
 * 结果缓存在内存和 localStorage（30 天），同一个 IP 不重复查询。内网、本机地址不查询。
 */
export type IpGeo = { country?: string; countryCode?: string; region?: string; city?: string; org?: string };
export type GeoLang = 'zh' | 'en';

const STORAGE_KEY = 'damail.ip-geo.v2';
const TTL = 30 * 86_400_000;
const MAX_ENTRIES = 500;

type Stored = Record<string, { at: number; geo: IpGeo }>;

function readStore(): Stored {
  try {
    localStorage.removeItem('damail.ip-geo'); // 旧版（geojs，只有英文）的缓存
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Stored;
  } catch {
    return {};
  }
}

function cached(key: string) {
  const hit = readStore()[key];
  return hit && Date.now() - hit.at < TTL ? hit.geo : undefined;
}

function remember(key: string, geo: IpGeo) {
  try {
    const store = readStore();
    store[key] = { at: Date.now(), geo };
    const entries = Object.entries(store)
      .filter(([, v]) => Date.now() - v.at < TTL)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 无痕模式等存不了就只缓存在内存里
  }
}

/** 去掉 IPv4 映射前缀（::ffff:1.2.3.4） */
const normalize = (ip: string) => ip.replace(/^::ffff:/i, '');

/** 内网、本机、链路本地地址：不发给第三方查询 */
export function privateLabel(raw: string): string | null {
  const ip = normalize(raw).toLowerCase();
  if (ip === 'local' || ip === '::1' || ip.startsWith('127.')) return t.audit.localhost;
  if (/^(10\.|192\.168\.|169\.254\.)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip))
    return t.audit.privateAddr;
  if (/^(fc|fd|fe80)/.test(ip)) return t.audit.privateAddr;
  if (!/^[0-9a-f:.]+$/.test(ip)) return t.audit.unknownAddr;
  return null;
}

// 运营商、云厂商的中文名（接口只返回英文）；其他公司名保持原文
const ISP_ZH: [RegExp, string][] = [
  [/china\s*telecom|chinanet|ctcc/i, '中国电信'],
  [/china\s*unicom|cncgroup|china\s*netcom/i, '中国联通'],
  [/china\s*mobile|cmnet/i, '中国移动'],
  [/china\s*broadnet|china\s*broadcasting/i, '中国广电'],
  [/cernet|china\s*education/i, '教育网'],
  [/china\s*tietong/i, '中国铁通'],
  [/great\s*wall\s*broadband|gwbn/i, '长城宽带'],
  [/alibaba|aliyun|alicloud/i, '阿里云'],
  [/tencent/i, '腾讯云'],
  [/huawei/i, '华为云'],
  [/baidu/i, '百度云'],
  [/bytedance|volcano\s*engine|volcengine/i, '火山引擎'],
  [/kingsoft/i, '金山云'],
  [/ucloud/i, 'UCloud'],
  [/jd\s*cloud|jingdong/i, '京东云'],
  [/qiniu/i, '七牛云'],
  [/hong\s*kong\s*broadband|hkbn/i, '香港宽频'],
  [/chunghwa\s*telecom|hinet/i, '中华电信'],
  [/pccw|netvigator/i, '电讯盈科'],
  [/amazon/i, '亚马逊云'],
  [/microsoft/i, '微软'],
  [/google/i, '谷歌'],
  [/cloudflare/i, 'Cloudflare'],
];

const ispName = (isp: string | undefined, lang: GeoLang) => (isp && lang === 'zh' ? (ISP_ZH.find(([re]) => re.test(isp))?.[1] ?? isp) : isp);

type IpWhoIs = {
  success?: boolean;
  message?: string;
  country?: string;
  country_code?: string;
  region?: string;
  city?: string;
  connection?: { isp?: string; org?: string };
};

async function lookup(raw: string, lang: GeoLang): Promise<IpGeo> {
  const ip = normalize(raw);
  const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?lang=${lang === 'zh' ? 'zh-CN' : 'en'}`, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!res.ok) throw new Error(`${t.audit.lookupFailed} (${res.status})`);
  const d = (await res.json()) as IpWhoIs;
  if (d.success === false) throw new Error(d.message || t.audit.lookupFailed);
  const geo: IpGeo = {
    country: d.country || undefined,
    countryCode: d.country_code || undefined,
    region: d.region || undefined,
    city: d.city || undefined,
    org: ispName(d.connection?.isp || d.connection?.org, lang),
  };
  remember(`${lang}:${raw}`, geo);
  return geo;
}

/** 中文「中国 湖北省 武汉」，英文「Wuhan, Hubei, China」；相同的层级只显示一次 */
export function formatPlace(geo: IpGeo, lang: GeoLang) {
  const parts = [geo.country, geo.region, geo.city].filter((x): x is string => Boolean(x));
  const uniq = parts.filter((x, i) => parts.indexOf(x) === i);
  if (!uniq.length) return t.audit.unknownPlace;
  return lang === 'zh' ? uniq.join(' ') : uniq.reverse().join(', ');
}

/** 当前界面语言（antd ConfigProvider 的 locale），中文以外一律用英文 */
export function useGeoLang(): GeoLang {
  const { locale } = useContext(ConfigProvider.ConfigContext);
  return (locale?.locale ?? document.documentElement.lang ?? 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** 点击后才查询；别处已经查过（或本地有缓存）的 IP 直接显示 */
export function useIpGeo(ip: string) {
  const lang = useGeoLang();
  const local = privateLabel(ip);
  const [asked, setAsked] = useState(false);
  const q = useQuery({
    queryKey: ['ip-geo', lang, ip],
    queryFn: () => lookup(ip, lang),
    enabled: asked && !local,
    initialData: () => (local ? undefined : cached(`${lang}:${ip}`)),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
  return {
    lang,
    local,
    geo: q.data,
    place: q.data ? formatPlace(q.data, lang) : undefined,
    loading: q.isFetching,
    error: q.isError ? (q.error as Error).message : null,
    query: () => {
      if (local || q.isFetching) return;
      if (asked && q.isError) void q.refetch();
      setAsked(true);
    },
  };
}
