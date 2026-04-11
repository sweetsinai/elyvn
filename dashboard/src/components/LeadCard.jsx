import { Phone, MessageSquare } from 'lucide-react';
import { formatPhone, timeAgo } from '../lib/utils';

function scoreColor(score) {
  if (score >= 8) return '#4ade80';
  if (score >= 5) return '#fbbf24';
  return '#f87171';
}

export default function LeadCard({ lead, onDragStart, onClick }) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify(lead));
        onDragStart?.(lead);
      }}
      onClick={() => onClick?.(lead)}
      className="card"
      role="button"
      tabIndex={0}
      aria-label={`Lead: ${lead.name || lead.phone}, score ${lead.score || 0}/10. Drag to move to another stage or click to view details.`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.(lead);
        }
      }}
      style={{
        padding: '10px 12px',
        marginBottom: 6,
        cursor: 'grab',
        transition: 'all 0.15s',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = 'rgba(212,175,55,0.03)';
        e.currentTarget.style.borderColor = 'rgba(212,175,55,0.2)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = '#111111';
        e.currentTarget.style.borderColor = 'rgba(212,175,55,0.12)';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Score dot */}
        <div style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: scoreColor(lead.score || 0),
          flexShrink: 0,
        }} />

        {/* Name */}
        <div style={{ flex: 1, fontSize: 13, fontWeight: 500 }} className="truncate">
          {lead.name || formatPhone(lead.phone)}
        </div>

        {/* Source icon */}
        {lead.source === 'call' ? (
          <Phone size={12} color="#888" />
        ) : (
          <MessageSquare size={12} color="#888" />
        )}
      </div>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 4,
      }}>
        {lead.phone && lead.name && (
          <span style={{ fontSize: 11, color: '#444' }}>
            {formatPhone(lead.phone)}
          </span>
        )}
        {lead.last_interaction && (
          <span style={{ fontSize: 10, color: '#444', marginLeft: 'auto' }}>
            {timeAgo(lead.last_interaction)}
          </span>
        )}
      </div>
    </div>
  );
}
