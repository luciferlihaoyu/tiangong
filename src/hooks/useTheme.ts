import { useState, useEffect, useCallback } from 'react';

type Theme = 'dark' | 'light';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('tiangong-theme') as Theme | null;
      if (saved) return saved;
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    return 'dark';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    // 同步 .dark class：tailwind.config.js 的 darkMode 为 ["class"]，
    // 只有挂上 .dark，shadcn 组件里的 dark: 变体才会生效
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('tiangong-theme', theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggle };
}
