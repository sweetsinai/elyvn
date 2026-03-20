import { useState } from 'react';
import { Phone, ChevronDown, ChevronUp, Loader } from 'lucide-react';
import StatusBadge from './StatusBadge';
import { getTranscript } from '../lib/api';
import { formatPhone, formatDuration, timeAgo } from '../lib/utils';

function scoreColor(score) {
  if (score >= 8) return '#16A34A';
  if (score >= 5) return '#EAB308';
  return '#DC2626';
}

export default function CallCard({ call, clientId }) {
  const [expanded, setExpanded] = useState(false);
  const [transcript, setTranscript] = useState(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);

  const handleLoadTranscript = async () => {
    if (transcript) return;
    setLoadingTranscript(true);
    try {
      const data = await getTranscript(clientId, call.id || call.call_id);
      setTranscript(data.transcript || data);
    } catch {
      setTranscript('Failed to load transcript');
    } finally {
      setLoadingTranscript(false);
    }
  };

  return (
    <div className="card fade-in" style={{ marginBottom: 8 }}>
      {/* Header row */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px',
          cursor: 'pointer',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.background = '#141414'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        <Phone size={14} color="#888" />
        <span style={{ fontSize: 12, color: '#888', minWidth: 70 }}>
          {timeAgo(call.created_at)}
        </span>
        <span style={{ fontSize: 13, minWidth: 120 }}>
          {formatPhone(call.caller_phone || call.from_number)}
        </span>
        <span style={{ fontSize: 12, color: '#888', minWidth: 60 }}>
          {formatDuration(call.duration)}
        </span>
        <StatusBadge status={call.outcome} type="outcome" />
        {call.score != null && (
          <span style={{
            fontSize: 12,
            fontWeight: 600,
            color: scoreColor(call.score),
            minWidth: 24,
            textAlign: 'center',
          }}>
            {call.score}/10
          </span>
        )}
        {call.sentiment && (
          <span style={{ fontSize: 11, color: '#555', marginLeft: 'auto' }}>
            {call.sentiment}
          </span>
        )}
        <div style={{ marginLeft: 'auto' }}>
          {expanded ? <ChevronUp size={14} color="#555" /> : <ChevronDown size={14} color="#555" />}
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div style={{
          padding: '0 16px 16px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
        }}>
          {call.summary && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, color: '#555', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Summary</div>
              <div style={{ fontSize: 13, color: '#e0d8c8', lineHeight: 1.6 }}>{call.summary}</div>
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            {!transcript ? (
              <button
                className="btn-secondary"
                onClick={handleLoadTranscript}
                disabled={loadingTranscript}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                {loadingTranscript && <Loader size={12} style={{ animation: 'spin 0.6s linear infinite' }} />}
                {loadingTranscript ? 'Loading...' : 'Load Transcript'}
              </button>
            ) : (
              <div>
                <div style={{ fontSize: 11, color: '#555', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Transcript</div>
                <pre style={{
                  fontSize: 12,
                  color: '#888',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'inherit',
                  maxHeight: 300,
                  overflowY: 'auto',
                  background: '#050505',
                  padding: 12,
                  borderRadius: 6,
                }}>
                  {typeof transcript === 'string' ? transcript : JSON.stringify(transcript, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
