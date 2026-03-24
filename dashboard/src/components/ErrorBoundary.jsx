import { Component } from 'react';

/**
 * ErrorBoundary — Catches render errors in child components.
 * Prevents the whole dashboard from crashing on a single component error.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary] Component crash:', error, errorInfo?.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: 40, textAlign: 'center',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', minHeight: 300,
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>!</div>
          <h2 style={{ margin: '0 0 8px', color: '#1a1a2e', fontWeight: 600 }}>Something went wrong</h2>
          <p style={{ color: '#666', marginBottom: 24, maxWidth: 400 }}>
            {this.state.error?.message || 'An unexpected error occurred in this section.'}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '10px 24px', background: '#667eea', color: '#fff',
              border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14,
              fontWeight: 500,
            }}
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
