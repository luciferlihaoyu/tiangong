import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, Outlet } from 'react-router'
import Starfield from './sections/Starfield'
import Login from './pages/Login'
import NotFound from './pages/NotFound'
import { AppLayout } from './sections/Navigation'
import { Toaster } from './components/ui/sonner'
import { useAuth } from './hooks/useAuth'

/* ═══════════════════════════════════════════
   路由级代码分割（碧霄 2026-02 P0 首屏减负）
   - 静态依赖只留：Starfield 背景、Login、NotFound、AppLayout 壳
   - 首页 6 个 section 与全部管理面板（共 24 个组件）一律 lazy()：
     此前 App 静态引 24 个业务组件，MatrixNodes/FooterTerminal 把
     three.js（1.1MB three-vendor chunk）拖进全站 modulepreload，
     现在仅首页真正挂载时才拉对应 chunk。
   ═══════════════════════════════════════════ */

// 首页 sections（FAQ 极轻也一并分割，保持策略一致）
const AppHub = lazy(() => import('./sections/AppHub'))
const Dashboard = lazy(() => import('./sections/Dashboard'))
const MatrixNodes = lazy(() => import('./sections/MatrixNodes'))
const ExecutionCore = lazy(() => import('./sections/ExecutionCore'))
const FAQ = lazy(() => import('./sections/FAQ'))
const FooterTerminal = lazy(() => import('./sections/FooterTerminal'))

// 业务页面
const AccountSettings = lazy(() => import('./sections/AccountSettings'))
const UsagePanel = lazy(() => import('./pages/UsagePanel'))
const ModelsPanel = lazy(() => import('./pages/ModelsPanel'))
const AlistPanel = lazy(() => import('./pages/AlistPanel'))
const OpsPanel = lazy(() => import('./pages/OpsPanel'))
const EventStream = lazy(() => import('./pages/EventStream'))
const GitHubPanel = lazy(() => import('./pages/GitHubPanel'))
const MailboxPanel = lazy(() => import('./pages/MailboxPanel'))
const ChatPanel = lazy(() => import('./pages/ChatPanel'))
const Tasks = lazy(() => import('./pages/Tasks'))
const TaskDetail = lazy(() => import('./pages/TaskDetail'))
const NotificationsPanel = lazy(() => import('./pages/NotificationsPanel'))
const AgentList = lazy(() => import('./pages/AgentList'))
const AgentDetail = lazy(() => import('./pages/AgentDetail'))
const SessionPanel = lazy(() => import('./pages/SessionPanel'))
const ConsolePanel = lazy(() => import('./pages/ConsolePanel'))
const PluginCenter = lazy(() => import('./pages/PluginCenter'))

function PageFallback() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="text-sm font-mono" style={{ color: 'var(--text-muted)' }}>加载中...</div>
    </div>
  )
}

/** 首页分块占位：给固定高度，chunk 陆续到达时逐块填充，减少 CLS */
function SectionFallback({ minHeight }: { minHeight: number }) {
  return <div style={{ minHeight }} />
}

function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="relative min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--bg-primary)' }}>
        <Starfield />
        <div className="text-sm font-mono" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}

function HomePage() {
  return (
    <>
      <Suspense fallback={<SectionFallback minHeight={0} />}>
        <AppHub />
      </Suspense>
      <Suspense fallback={<SectionFallback minHeight={420} />}>
        <Dashboard />
      </Suspense>
      <Suspense fallback={<SectionFallback minHeight={560} />}>
        <MatrixNodes />
      </Suspense>
      <Suspense fallback={<SectionFallback minHeight={480} />}>
        <ExecutionCore />
      </Suspense>
      <Suspense fallback={<SectionFallback minHeight={400} />}>
        <FAQ />
      </Suspense>
      <Suspense fallback={<SectionFallback minHeight={220} />}>
        <FooterTerminal />
      </Suspense>
    </>
  )
}

export default function App() {
  return (
    <div className="relative min-h-screen" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <Toaster position="top-right" />
      <Starfield />
      <Routes>
        {/* Public routes — no layout */}
        <Route path="/login" element={<Login />} />

        {/* Protected routes — with AppLayout */}
        <Route element={
          <ProtectedLayout>
            <AppLayout>
              <Suspense fallback={<PageFallback />}>
                <Outlet />
              </Suspense>
            </AppLayout>
          </ProtectedLayout>
        }>
          <Route path="/" element={<HomePage />} />
          <Route path="/account" element={<AccountSettings />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/missions" element={<Navigate to="/tasks?tab=log" replace />} />
          <Route path="/task-center" element={<Navigate to="/tasks?tab=center" replace />} />
          <Route path="/usage" element={<UsagePanel />} />
          <Route path="/models" element={<ModelsPanel />} />
          <Route path="/alist" element={<AlistPanel />} />
          <Route path="/ops" element={<OpsPanel />} />
          <Route path="/agents" element={<AgentList />} />
          <Route path="/agents/:agentId" element={<AgentDetail />} />
          <Route path="/events" element={<EventStream />} />
          <Route path="/dag" element={<Navigate to="/tasks?tab=dag" replace />} />
          <Route path="/taskboard" element={<Navigate to="/tasks?tab=board" replace />} />
          <Route path="/notifications" element={<NotificationsPanel />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/mailbox" element={<MailboxPanel />} />
          <Route path="/chat" element={<ChatPanel />} />
          <Route path="/sessions" element={<SessionPanel />} />
          <Route path="/github" element={<GitHubPanel />} />
          <Route path="/console" element={<ConsolePanel />} />
          <Route path="/plugins" element={<PluginCenter />} />
        </Route>

        {/* 404 — show nav but no auth requirement */}
        <Route path="*" element={
          <AppLayout>
            <NotFound />
          </AppLayout>
        } />
      </Routes>
    </div>
  )
}
