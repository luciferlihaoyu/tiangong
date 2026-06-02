import { Routes, Route } from 'react-router'
import Navigation from './sections/Navigation'
import Starfield from './sections/Starfield'
import Dashboard from './sections/Dashboard'
import MatrixNodes from './sections/MatrixNodes'
import Features from './sections/Features'
import ExecutionCore from './sections/ExecutionCore'
import FAQ from './sections/FAQ'
import FooterTerminal from './sections/FooterTerminal'
import Login from './pages/Login'
import NotFound from './pages/NotFound'

export default function App() {
  return (
    <div className="relative min-h-screen" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <Starfield />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={
          <>
            <Navigation />
            <Routes>
              <Route path="/" element={
                <>
                  <Dashboard />
                  <MatrixNodes />
                  <Features />
                  <ExecutionCore />
                  <FAQ />
                  <FooterTerminal />
                </>
              } />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </>
        } />
      </Routes>
    </div>
  )
}
