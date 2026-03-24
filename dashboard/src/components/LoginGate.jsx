import { useState, useEffect } from 'react';

/**
 * LoginGate — Simple API key authentication gate.
 * Stores the API key in sessionStorage (cleared on tab close).
 * Validates against the /health endpoint before granting access.
 */
export default function LoginGate({ children }) {
  const [apiKey, setApiKey] = useState('');
  const [inputKey, setInputKey] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);

  // Check for existing session on mount
  useEffect(() => {
    const stored = sessionStorage.getItem('elyvn_api_key');
    if (stored) {
      validateKey(stored).then(valid => {
        if (valid) setApiKey(stored);
        setChecking(false);
      });
    } else {
      setChecking(false);
    }
  }, []);

  async function validateKey(key) {
    try {
      const res = await fetch('/api/clients', {
        headers: { 'x-api-key': key },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    setChecking(true);

    const trimmed = inputKey.trim();
    if (!trimmed) {
      setError('Please enter your API key');
      setChecking(false);
      return;
    }

    const valid = await validateKey(trimmed);
    if (valid) {
      sessionStorage.setItem('elyvn_api_key', trimmed);
      setApiKey(trimmed);
    } else {
      setError('Invalid API key. Check your ELYVN_API_KEY.');
    }
    setChecking(false);
  }

  function handleLogout() {
    sessionStorage.removeItem('elyvn_api_key');
    setApiKey('');
    setInputKey('');
  }

  if (checking) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#f5f5f5' }}>
        <p style={{ color: '#666', fontSize: 16 }}>Loading...</p>
      </div>
    );
  }

  if (!apiKey) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      }}>
        <div style={{
          background: '#fff', borderRadius: 16, padding: '48px 40px', width: 380,
          boxShadow: '0 20px 60px rgba(0,0,0,0.15)', textAlign: 'center',
        }}>
          <div style={{ fontSize: 32, fontWeight: 700, marginBottom: 8, color: '#1a1a2e' }}>
            ELYVN
          </div>
          <p style={{ color: '#666', fontSize: 14, marginBottom: 32 }}>
            Enter your API key to access the dashboard
          </p>
          <form onSubmit={handleLogin}>
            <input
              type="password"
              value={inputKey}
              onChange={e => setInputKey(e.target.value)}
              placeholder="Your ELYVN API key"
              style={{
                width: '100%', padding: '12px 16px', fontSize: 14,
                border: '2px solid #e0e0e0', borderRadius: 8, outline: 'none',
                boxSizing: 'border-box', transition: 'border 0.2s',
              }}
              onFocus={e => e.target.style.borderColor = '#667eea'}
              onBlur={e => e.target.style.borderColor = '#e0e0e0'}
              autoFocus
            />
            {error && (
              <p style={{ color: '#e74c3c', fontSize: 13, marginTop: 8, marginBottom: 0 }}>{error}</p>
            )}
            <button
              type="submit"
              disabled={checking}
              style={{
                width: '100%', padding: '12px 0', marginTop: 16,
                background: 'linear-gradient(135deg, #667eea, #764ba2)',
                color: '#fff', border: 'none', borderRadius: 8, fontSize: 15,
                fontWeight: 600, cursor: checking ? 'not-allowed' : 'pointer',
                opacity: checking ? 0.7 : 1,
              }}
            >
              {checking ? 'Checking...' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Inject logout function and apiKey into children context
  return typeof children === 'function'
    ? children({ apiKey, onLogout: handleLogout })
    : children;
}
