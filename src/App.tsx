import Navigation from './sections/Navigation';
import Dashboard from './sections/Dashboard';
import MatrixNodes from './sections/MatrixNodes';
import Features from './sections/Features';
import ExecutionCore from './sections/ExecutionCore';
import FAQ from './sections/FAQ';
import FooterTerminal from './sections/FooterTerminal';

export default function App() {
  return (
    <div className="relative min-h-screen" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <Navigation />
      <Dashboard />
      <MatrixNodes />
      <Features />
      <ExecutionCore />
      <FAQ />
      <FooterTerminal />
    </div>
  );
}
