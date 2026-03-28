import { useState, useEffect } from 'react';

const API_BASE = window.location.origin;

export default function LoginGate({ children }) {
  const [auth, setAuth] = useState(null); // { token, clientId, email, business_name }
  const [mode, setMode] = useState('login'); // login | signup | api_key
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');

  // Check existing session
  useEffect(() => {
    const token = sessionStorage.getItem('elyvn_token');
    const apiKey = sessionStorage.getItem('elyvn_api_key');

    if (token) {
      fetch(`${API_BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(data => {
          setAuth({ token, ...data });
          setChecking(false);
        })
        .catch(() => {
          sessionStorage.removeItem('elyvn_token');
          setChecking(false);
        });
    } else if (apiKey) {
      // Legacy API key auth
      fetch(`${API_BASE}/api/clients`, { headers: { 'x-api-key': apiKey } })
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(() => {
          setAuth({ apiKey, legacy: true });
          sessionStorage.setItem('elyvn_api_key', apiKey);
          setChecking(false);
        })
        .catch(() => {
          sessionStorage.removeItem('elyvn_api_key');
          setChecking(false);
        });
    } else {
      setChecking(false);
    }
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');

      sessionStorage.setItem('elyvn_token', data.token);
      sessionStorage.setItem('elyvn_client_id', data.clientId);
      // Also set api key for backward compatibility with existing apiFetch
      sessionStorage.setItem('elyvn_api_key', data.token);
      setAuth(data);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  async function handleSignup(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          password,
          business_name: businessName.trim(),
          owner_name: ownerName.trim(),
          owner_phone: ownerPhone.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Signup failed');

      sessionStorage.setItem('elyvn_token', data.token);
      sessionStorage.setItem('elyvn_client_id', data.clientId);
      sessionStorage.setItem('elyvn_api_key', data.token);
      setAuth(data);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  async function handleApiKey(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/clients`, {
        headers: { 'x-api-key': apiKeyInput.trim() },
      });
      if (!res.ok) throw new Error('Invalid API key');
      sessionStorage.setItem('elyvn_api_key', apiKeyInput.trim());
      setAuth({ apiKey: apiKeyInput.trim(), legacy: true });
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  if (checking) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a1a' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#fff', letterSpacing: 4 }}>ELYVN</div>
          <div style={{ color: '#666', marginTop: 12, fontSize: 14 }}>Loading...</div>
        </div>
      </div>
    );
  }

  if (!auth) {
    const inputStyle = {
      width: '100%', padding: '12px 16px', fontSize: 14,
      border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, outline: 'none',
      boxSizing: 'border-box', background: 'rgba(255,255,255,0.05)', color: '#fff',
      transition: 'border 0.2s',
    };

    const btnStyle = {
      width: '100%', padding: '14px 0', marginTop: 20,
      background: 'linear-gradient(135deg, #7C3AED, #4F46E5)',
      color: '#fff', border: 'none', borderRadius: 10, fontSize: 15,
      fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer',
      opacity: loading ? 0.7 : 1, letterSpacing: 0.5,
    };

    const linkStyle = {
      color: '#7C3AED', cursor: 'pointer', fontSize: 13, fontWeight: 500,
      background: 'none', border: 'none', textDecoration: 'underline',
    };

    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh',
        background: 'linear-gradient(135deg, #0a0a1a 0%, #1a1040 100%)',
        fontFamily: "'Inter', -apple-system, sans-serif",
      }}>
        <div style={{
          background: 'rgba(255,255,255,0.03)', borderRadius: 20, padding: '48px 40px', width: 400,
          border: '1px solid rgba(255,255,255,0.06)', backdropFilter: 'blur(20px)',
        }}>
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#fff', letterSpacing: 4, marginBottom: 6 }}>ELYVN</div>
            <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>
              {mode === 'login' && 'Sign in to your dashboard'}
              {mode === 'signup' && 'Create your account'}
              {mode === 'api_key' && 'Enter your API key'}
            </div>
          </div>

          {mode === 'login' && (
            <form onSubmit={handleLogin}>
              <div style={{ marginBottom: 14 }}>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="Email" style={inputStyle} autoFocus required />
              </div>
              <div style={{ marginBottom: 4 }}>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="Password" style={inputStyle} required />
              </div>
              {error && <p style={{ color: '#EF4444', fontSize: 13, marginTop: 8 }}>{error}</p>}
              <button type="submit" disabled={loading} style={btnStyle}>
                {loading ? 'Signing in...' : 'Sign In'}
              </button>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
                <button type="button" onClick={() => { setMode('signup'); setError(''); }} style={linkStyle}>
                  Create account
                </button>
                <button type="button" onClick={() => { setMode('api_key'); setError(''); }} style={linkStyle}>
                  Use API key
                </button>
              </div>
            </form>
          )}

          {mode === 'signup' && (
            <form onSubmit={handleSignup}>
              <div style={{ marginBottom: 14 }}>
                <input type="text" value={businessName} onChange={e => setBusinessName(e.target.value)}
                  placeholder="Business Name" style={inputStyle} autoFocus required />
              </div>
              <div style={{ marginBottom: 14 }}>
                <input type="text" value={ownerName} onChange={e => setOwnerName(e.target.value)}
                  placeholder="Your Name" style={inputStyle} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="Email" style={inputStyle} required />
              </div>
              <div style={{ marginBottom: 14 }}>
                <input type="tel" value={ownerPhone} onChange={e => setOwnerPhone(e.target.value)}
                  placeholder="Phone Number" style={inputStyle} />
              </div>
              <div style={{ marginBottom: 4 }}>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="Password (min 8 characters)" style={inputStyle} required minLength={8} />
              </div>
              {error && <p style={{ color: '#EF4444', fontSize: 13, marginTop: 8 }}>{error}</p>}
              <button type="submit" disabled={loading} style={btnStyle}>
                {loading ? 'Creating account...' : 'Create Account'}
              </button>
              <div style={{ textAlign: 'center', marginTop: 16 }}>
                <button type="button" onClick={() => { setMode('login'); setError(''); }} style={linkStyle}>
                  Already have an account? Sign in
                </button>
              </div>
            </form>
          )}

          {mode === 'api_key' && (
            <form onSubmit={handleApiKey}>
              <div style={{ marginBottom: 4 }}>
                <input type="password" value={apiKeyInput} onChange={e => setApiKeyInput(e.target.value)}
                  placeholder="Your ELYVN API key" style={inputStyle} autoFocus required />
              </div>
              {error && <p style={{ color: '#EF4444', fontSize: 13, marginTop: 8 }}>{error}</p>}
              <button type="submit" disabled={loading} style={btnStyle}>
                {loading ? 'Checking...' : 'Sign In with API Key'}
              </button>
              <div style={{ textAlign: 'center', marginTop: 16 }}>
                <button type="button" onClick={() => { setMode('login'); setError(''); }} style={linkStyle}>
                  Use email & password instead
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  return typeof children === 'function'
    ? children({ auth, onLogout: () => { sessionStorage.clear(); setAuth(null); } })
    : children;
}
