import { Routes, Route, Navigate } from 'react-router'
import Navigation from './sections/Navigation'
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

export default function App() {
  return (
    <div className="relative min-h-screen" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <Starfield />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={
          <ProtectedLayout>
            <Navigation />
            <Dashboard />
            <MatrixNodes />
            <Features />
            <ExecutionCore />
            <FAQ />
            <FooterTerminal />
          </ProtectedLayout>
        } />
        <Route path="/account" element={
          <ProtectedLayout>
            <Navigation />
            <AccountSettings />
          </ProtectedLayout>
        } />
        <Route path="/missions" element={
          <ProtectedLayout>
            <Navigation />
            <MissionLog />
          </ProtectedLayout>
        } />
        <Route path="*" element={
          <>
            <Navigation />
            <NotFound />
          </>
        } />
      </Routes>
    </div>
  )
}
