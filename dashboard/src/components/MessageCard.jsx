import { useState } from 'react';
import { MessageSquare, ChevronDown, ChevronUp } from 'lucide-react';
import StatusBadge from './StatusBadge';
import { formatPhone, timeAgo, truncate } from '../lib/utils';

export default function MessageCard({ message }) {
  const [expanded, setExpanded] = useState(false);

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
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(212,175,55,0.03)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        <MessageSquare size={14} color="#666" />
        <span style={{ fontSize: 12, color: '#666', minWidth: 70 }}>
          {timeAgo(message.created_at)}
        </span>
        <span style={{ fontSize: 13, minWidth: 120 }}>
          {formatPhone(message.from_number || message.sender_phone)}
        </span>
        <span style={{ fontSize: 12, color: '#666', flex: 1 }} className="truncate">
          {truncate(message.original_message || message.body, 60)}
        </span>
        {message.ai_reply && (
          <span style={{ fontSize: 12, color: '#555', maxWidth: 160 }} className="truncate">
            {truncate(message.ai_reply, 40)}
          </span>
        )}
        <StatusBadge status={message.reply_source || message.source} type="source" />
        <StatusBadge status={message.status} type="status" />
        <div style={{ marginLeft: 'auto' }}>
          {expanded ? <ChevronUp size={14} color="#555" /> : <ChevronDown size={14} color="#555" />}
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div style={{
          padding: '0 16px 16px',
          borderTop: '1px solid rgba(212,175,55,0.08)',
        }}>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, color: '#444', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
              Original Message
            </div>
            <div style={{ fontSize: 13, color: '#F5F5F0', lineHeight: 1.6 }}>
              {message.original_message || message.body || 'N/A'}
            </div>
          </div>

          {message.ai_reply && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, color: '#444', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                AI Reply
              </div>
              <div style={{
                fontSize: 13,
                color: '#aaa',
                lineHeight: 1.6,
                background: '#0a0a0a',
                padding: 12,
                borderRadius: 14,
              }}>
                {message.ai_reply}
              </div>
            </div>
          )}

          {message.escalated && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, color: '#444', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                Escalation
              </div>
              <div style={{ fontSize: 13, color: '#fbbf24' }}>
                {message.escalation_reason || 'Escalated to owner'}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
