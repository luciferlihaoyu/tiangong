import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import { TRPCProvider } from '@/providers/trpc'
import ErrorBoundary from '@/components/ErrorBoundary'
import { installChunkSelfHeal } from '@/lib/chunk-self-heal'
import './index.css'
import App from './App.tsx'

// 部署切换后旧 tab 拿不到旧 hash chunk 时自动刷新一次（须先于首次渲染，
// lazy 页面的动态 import 可能发生在首帧）
installChunkSelfHeal()

createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <TRPCProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </TRPCProvider>
  </HashRouter>
)
