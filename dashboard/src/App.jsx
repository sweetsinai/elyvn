import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import Calls from './pages/Calls';
import Messages from './pages/Messages';
import Pipeline from './pages/Pipeline';
import Outreach from './pages/Outreach';
import Settings from './pages/Settings';

export default function App() {
  return (
    <BrowserRouter>
      <div style={{ display: 'flex', height: '100vh' }}>
        <Sidebar />
        <main style={{
          marginLeft: 240,
          flex: 1,
          overflowY: 'auto',
          padding: '32px 40px',
          minHeight: '100vh',
        }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/calls" element={<Calls />} />
            <Route path="/messages" element={<Messages />} />
            <Route path="/pipeline" element={<Pipeline />} />
            <Route path="/outreach" element={<Outreach />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
