import React from 'react';

export function LoadingSkeleton({ rows = 5, columns = 4 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex', gap: 16 }}>
          {Array.from({ length: columns }).map((_, j) => (
            <div key={j} style={{
              height: 16,
              background: 'rgba(212,175,55,0.06)',
              borderRadius: 6,
              flex: 1,
            }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ count = 4 }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{
          background: '#111111',
          borderRadius: 14,
          border: '1px solid rgba(212,175,55,0.12)',
          padding: 16,
        }}>
          <div style={{ height: 12, background: 'rgba(212,175,55,0.06)', borderRadius: 6, width: '50%', marginBottom: 12 }} />
          <div style={{ height: 32, background: 'rgba(212,175,55,0.06)', borderRadius: 6, width: '75%', marginBottom: 8 }} />
          <div style={{ height: 12, background: 'rgba(212,175,55,0.06)', borderRadius: 6, width: '33%' }} />
        </div>
      ))}
    </div>
  );
}
