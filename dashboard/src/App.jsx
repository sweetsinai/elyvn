import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import LoginGate from './components/LoginGate';
import ErrorBoundary from './components/ErrorBoundary';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import Calls from './pages/Calls';
import Messages from './pages/Messages';
import Pipeline from './pages/Pipeline';
import Intelligence from './pages/Intelligence';
import Outreach from './pages/Outreach';
import Settings from './pages/Settings';
import Clients from './pages/Clients';
import ClientDetail from './pages/ClientDetail';
import Provision from './pages/Provision';
import Bookings from './pages/Bookings';
import Onboard from './pages/Onboard';

export default function App() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <LoginGate>
      <BrowserRouter>
        <div style={{ display: 'flex', height: '100vh' }}>
          <Sidebar mobileMenuOpen={mobileMenuOpen} onCloseMobile={() => setMobileMenuOpen(false)} />
          <main style={{
            marginLeft: 'var(--sidebar-margin)',
            flex: 1,
            overflowY: 'auto',
            padding: 'var(--main-padding)',
            minHeight: '100vh',
          }}>
            <div style={{
              display: 'none',
              position: 'fixed',
              top: 16,
              left: 16,
              zIndex: 40,
            }} className="hamburger-menu">
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                aria-label="Toggle navigation menu"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-primary)',
                  padding: '8px',
                  borderRadius: 'var(--radius)',
                  cursor: 'pointer',
                }}
              >
                {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
              </button>
            </div>
            <ErrorBoundary>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/calls" element={<Calls />} />
                <Route path="/messages" element={<Messages />} />
                <Route path="/pipeline" element={<Pipeline />} />
                <Route path="/intelligence" element={<Intelligence />} />
                <Route path="/outreach" element={<Outreach />} />
                <Route path="/clients" element={<Clients />} />
                <Route path="/client-detail" element={<ClientDetail />} />
                <Route path="/provision" element={<Provision />} />
                <Route path="/bookings" element={<Bookings />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/onboard" element={<Onboard />} />
              </Routes>
            </ErrorBoundary>
          </main>
        </div>
      </BrowserRouter>
    </LoginGate>
  );
}
