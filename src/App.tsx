import { Routes, Route, Navigate, Outlet } from 'react-router'
import Starfield from './sections/Starfield'
import Dashboard from './sections/Dashboard'
import MatrixNodes from './sections/MatrixNodes'
import Features from './sections/Features'
import ExecutionCore from './sections/ExecutionCore'
import FAQ from './sections/FAQ'
import FooterTerminal from './sections/FooterTerminal'
import AccountSettings from './sections/AccountSettings'
import Login from './pages/Login'
import NotFound from './pages/NotFound'
import MissionLog from './pages/MissionLog'
import TaskCenter from './pages/TaskCenter'
import UsagePanel from './pages/UsagePanel'
import PricingPanel from './pages/PricingPanel'
import GuardPanel from './pages/GuardPanel'
import OpsPanel from './pages/OpsPanel'
import FusionPanel from './pages/FusionPanel'
import EventStream from './pages/EventStream'
import DagPanel from './pages/DagPanel'
import GitHubPanel from './pages/GitHubPanel'
import MailboxPanel from './pages/MailboxPanel'
import TaskBoard from './pages/TaskBoard'
import TaskDetail from './pages/TaskDetail'
import SessionPanel from './pages/SessionPanel'
import { AppLayout } from './sections/Navigation'
import { useAuth } from './hooks/useAuth'

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
      <Dashboard />
      <MatrixNodes />
      <Features />
      <ExecutionCore />
      <FAQ />
      <FooterTerminal />
    </>
  )
}

export default function App() {
  return (
    <div className="relative min-h-screen" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <Starfield />
      <Routes>
        {/* Public routes — no layout */}
        <Route path="/login" element={<Login />} />

        {/* Protected routes — with AppLayout */}
        <Route element={
          <ProtectedLayout>
            <AppLayout>
              <Outlet />
            </AppLayout>
          </ProtectedLayout>
        }>
          <Route path="/" element={<HomePage />} />
          <Route path="/account" element={<AccountSettings />} />
          <Route path="/missions" element={<MissionLog />} />
          <Route path="/task-center" element={<TaskCenter />} />
          <Route path="/usage" element={<UsagePanel />} />
          <Route path="/pricing" element={<PricingPanel />} />
          <Route path="/guard" element={<GuardPanel />} />
          <Route path="/ops" element={<OpsPanel />} />
          <Route path="/fusion" element={<FusionPanel />} />
          <Route path="/events" element={<EventStream />} />
          <Route path="/dag" element={<DagPanel />} />
          <Route path="/taskboard" element={<TaskBoard />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/mailbox" element={<MailboxPanel />} />
          <Route path="/sessions" element={<SessionPanel />} />
          <Route path="/github" element={<GitHubPanel />} />
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
