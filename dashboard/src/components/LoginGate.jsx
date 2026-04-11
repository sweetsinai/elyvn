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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#050505' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            fontSize: 28, fontWeight: 700, letterSpacing: 4,
            fontFamily: "'Cormorant Garamond', serif",
            background: 'linear-gradient(120deg, #EED07A 0%, #D4AF37 42%, #9A7840 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}>ELYVN</div>
          <div style={{ color: '#666', marginTop: 12, fontSize: 14 }}>Loading...</div>
        </div>
      </div>
    );
  }

  if (!auth) {
    const inputStyle = {
      width: '100%', padding: '12px 16px', fontSize: 14,
      border: '1px solid rgba(212,175,55,0.15)', borderRadius: 14, outline: 'none',
      boxSizing: 'border-box', background: '#0a0a0a', color: '#F5F5F0',
      transition: 'border 0.2s',
    };

    const btnStyle = {
      width: '100%', padding: '14px 0', marginTop: 20,
      background: 'linear-gradient(135deg, #EED07A 0%, #D4AF37 50%, #9A7840 100%)',
      color: '#050505', border: 'none', borderRadius: 14, fontSize: 15,
      fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer',
      opacity: loading ? 0.7 : 1, letterSpacing: '0.1em',
      textTransform: 'uppercase',
    };

    const linkStyle = {
      color: '#D4AF37', cursor: 'pointer', fontSize: 13, fontWeight: 500,
      background: 'none', border: 'none', textDecoration: 'underline',
    };

    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh',
        background: '#050505',
        backgroundImage: 'radial-gradient(ellipse 60% 50% at 50% 50%, rgba(212,175,55,0.04) 0%, transparent 70%)',
        fontFamily: "'Inter', -apple-system, sans-serif",
      }}>
        <div style={{
          background: 'rgba(17,17,17,0.85)', borderRadius: 24, padding: '48px 40px', width: 400,
          border: '1px solid rgba(212,175,55,0.15)', backdropFilter: 'blur(12px)',
          boxShadow: '0 0 32px rgba(212,175,55,0.18)',
          position: 'relative', overflow: 'hidden',
        }}>
          {/* Shimmer line */}
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 1,
            background: 'linear-gradient(90deg, transparent 0%, #D4AF37 50%, transparent 100%)',
          }} />
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <div style={{
              fontSize: 28, fontWeight: 700, letterSpacing: 4, marginBottom: 6,
              fontFamily: "'Cormorant Garamond', serif",
              background: 'linear-gradient(120deg, #EED07A 0%, #D4AF37 42%, #9A7840 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}>ELYVN</div>
            <div style={{ color: '#444', fontSize: 13 }}>
              {mode === 'login' && 'Sign in to your dashboard'}
              {mode === 'signup' && 'Create your account'}
              {mode === 'api_key' && 'Enter your API key'}
            </div>
          </div>

          {mode === 'login' && (
            <form onSubmit={handleLogin}>
              <div style={{ marginBottom: 14 }}>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="Email" style={inputStyle} autoFocus required
                  onFocus={e => { e.target.style.border = '1px solid rgba(212,175,55,0.4)'; }}
                  onBlur={e => { e.target.style.border = '1px solid rgba(212,175,55,0.15)'; }} />
              </div>
              <div style={{ marginBottom: 4 }}>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="Password" style={inputStyle} required
                  onFocus={e => { e.target.style.border = '1px solid rgba(212,175,55,0.4)'; }}
                  onBlur={e => { e.target.style.border = '1px solid rgba(212,175,55,0.15)'; }} />
              </div>
              {error && <p style={{ color: '#f87171', fontSize: 13, marginTop: 8 }}>{error}</p>}
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
                  placeholder="Business Name" style={inputStyle} autoFocus required
                  onFocus={e => { e.target.style.border = '1px solid rgba(212,175,55,0.4)'; }}
                  onBlur={e => { e.target.style.border = '1px solid rgba(212,175,55,0.15)'; }} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <input type="text" value={ownerName} onChange={e => setOwnerName(e.target.value)}
                  placeholder="Your Name" style={inputStyle}
                  onFocus={e => { e.target.style.border = '1px solid rgba(212,175,55,0.4)'; }}
                  onBlur={e => { e.target.style.border = '1px solid rgba(212,175,55,0.15)'; }} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="Email" style={inputStyle} required
                  onFocus={e => { e.target.style.border = '1px solid rgba(212,175,55,0.4)'; }}
                  onBlur={e => { e.target.style.border = '1px solid rgba(212,175,55,0.15)'; }} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <input type="tel" value={ownerPhone} onChange={e => setOwnerPhone(e.target.value)}
                  placeholder="Phone Number" style={inputStyle}
                  onFocus={e => { e.target.style.border = '1px solid rgba(212,175,55,0.4)'; }}
                  onBlur={e => { e.target.style.border = '1px solid rgba(212,175,55,0.15)'; }} />
              </div>
              <div style={{ marginBottom: 4 }}>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="Password (min 8 characters)" style={inputStyle} required minLength={8}
                  onFocus={e => { e.target.style.border = '1px solid rgba(212,175,55,0.4)'; }}
                  onBlur={e => { e.target.style.border = '1px solid rgba(212,175,55,0.15)'; }} />
              </div>
              {error && <p style={{ color: '#f87171', fontSize: 13, marginTop: 8 }}>{error}</p>}
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
                  placeholder="Your ELYVN API key" style={inputStyle} autoFocus required
                  onFocus={e => { e.target.style.border = '1px solid rgba(212,175,55,0.4)'; }}
                  onBlur={e => { e.target.style.border = '1px solid rgba(212,175,55,0.15)'; }} />
              </div>
              {error && <p style={{ color: '#f87171', fontSize: 13, marginTop: 8 }}>{error}</p>}
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

          {/* System Online indicator */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 28 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: '#D4AF37',
              boxShadow: '0 0 8px rgba(212,175,55,0.6)',
              animation: 'pulse-gold 2s ease-in-out infinite',
            }} />
            <span style={{ fontSize: 11, color: '#444', letterSpacing: '0.05em' }}>System Online</span>
          </div>
          <style>{`
            @keyframes pulse-gold {
              0%, 100% { opacity: 1; box-shadow: 0 0 8px rgba(212,175,55,0.6); }
              50% { opacity: 0.5; box-shadow: 0 0 16px rgba(212,175,55,0.3); }
            }
          `}</style>
        </div>
      </div>
    );
  }

  return typeof children === 'function'
    ? children({ auth, onLogout: () => { sessionStorage.clear(); setAuth(null); } })
    : children;
}
