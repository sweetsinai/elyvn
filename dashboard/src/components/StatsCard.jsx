import { TrendingUp, TrendingDown } from 'lucide-react';

export default function StatsCard({ title, value, trend, icon: Icon, color = '#D4AF37' }) {
  const isPositive = trend >= 0;

  return (
    <div className="card card-shimmer" style={{ padding: 20, position: 'relative', overflow: 'hidden' }}>
      {/* Icon background accent */}
      <div style={{
        position: 'absolute',
        top: 16,
        right: 16,
        width: 36,
        height: 36,
        borderRadius: 10,
        background: `${color}15`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        {Icon && <Icon size={18} color={color} />}
      </div>

      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
        {title}
      </div>

      <div style={{ fontSize: 28, fontWeight: 700, color: '#F5F5F0', fontFamily: "'Cormorant Garamond', serif", marginBottom: 6 }}>
        {value}
      </div>

      {trend !== undefined && trend !== null && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 12,
          color: isPositive ? '#4ade80' : '#f87171',
        }}>
          {isPositive ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
          <span>{isPositive ? '+' : ''}{trend}%</span>
          <span style={{ color: '#444', marginLeft: 2 }}>vs last week</span>
        </div>
      )}
    </div>
  );
}
