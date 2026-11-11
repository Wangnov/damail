import { useEffect, useState, type CSSProperties } from 'react';
import { t } from '../i18n';
import { AuthForm, LangSwitch, LogoMark } from './auth/AuthForm';
import { useAuthSubmit, type AuthMode } from './auth/useAuthSubmit';
import './auth/auth.css';

/** 进场动画按顺序错开：style={stagger(2)} */
const stagger = (i: number) => ({ '--i': i }) as CSSProperties;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 逐字打出、停顿、再逐字删掉，轮换几个邮箱名；系统要求减少动态效果时固定显示第一个 */
function useTypewriter(words: string[]) {
  const [text, setText] = useState(reducedMotion() ? words[0]! : '');
  useEffect(() => {
    if (reducedMotion()) {
      setText(words[0]!);
      return;
    }
    let i = 0;
    let len = 0;
    let deleting = false;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const word = [...words[i % words.length]!];
      if (!deleting) {
        len++;
        setText(word.slice(0, len).join(''));
        if (len === word.length) {
          deleting = true;
          timer = setTimeout(step, 1600);
          return;
        }
        timer = setTimeout(step, 110);
      } else {
        len--;
        setText(word.slice(0, len).join(''));
        if (len === 0) {
          deleting = false;
          i++;
          timer = setTimeout(step, 300);
          return;
        }
        timer = setTimeout(step, 55);
      }
    };
    timer = setTimeout(step, 500);
    return () => clearTimeout(timer);
  }, [words]);
  return text;
}

/** 信封线稿：进场时一笔笔画出来；加载闪烁、成功变绿、出错变红（颜色由根元素的 phase-* 决定） */
function EnvelopeLine({ style }: { style?: CSSProperties }) {
  return (
    // 进场动画放在外层，避免加载时的闪烁结束后又重播一次进场
    <div className="auth-enter" style={style}>
      <svg className="auth-envelope" viewBox="0 0 160 112" aria-hidden="true">
        <rect x="6" y="6" width="148" height="100" rx="12" />
        <path d="M10 14 L80 64 L150 14" />
        <path className="auth-envelope-fold" d="M10 102 L62 52 M150 102 L98 52" />
      </svg>
    </div>
  );
}

/** 登录 / 初始化页：左侧打字标题和功能介绍，右侧表单；窄屏只留表单 */
export function AuthPage({ mode }: { mode: AuthMode }) {
  const auth = useAuthSubmit(mode);
  const word = useTypewriter(t.auth.typeWords);
  return (
    <div className={`auth-page phase-${auth.phase}`}>
      <div className="auth-topline" aria-hidden="true" />
      <section className="auth-side">
        <div className="auth-side-logo auth-enter" style={stagger(0)}>
          <LogoMark />
          DaMail
        </div>
        <EnvelopeLine style={stagger(1)} />
        <h1 className="auth-headline auth-enter" style={stagger(2)}>
          {t.auth.typeLead}{' '}
          <span className="auth-word">
            {word}
            <i className="auth-caret" aria-hidden="true" />
          </span>
          <br />
          {t.auth.typeTail}
        </h1>
        <ol className="auth-features">
          {t.auth.features.map((f, i) => (
            <li key={f.title} className="auth-enter" style={stagger(3 + i)}>
              <span className="auth-num">0{i + 1}</span>
              <span>
                <b>{f.title}</b>
                <span>{f.desc}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>
      <main className="auth-main">
        <LangSwitch className="auth-lang" />
        <AuthForm
          auth={auth}
          mode={mode}
          logo={
            <div className="auth-compact-logo">
              <LogoMark />
              DaMail
            </div>
          }
        />
        <div className="auth-main-foot">{t.auth.selfHosted}</div>
      </main>
    </div>
  );
}
