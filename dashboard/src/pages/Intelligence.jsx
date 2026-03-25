import { useState, useEffect, useCallback } from 'react';
import {
  Brain,
  TrendingUp,
  Clock,
  Target,
  DollarSign,
  BarChart3,
  Calendar,
} from 'lucide-react';
import StatsCard from '../components/StatsCard';
import {
  getIntelligence,
  getPeakHours,
  getResponseImpact,
  getLeadScores,
  getConversionAnalytics,
  getRevenue,
  getChannelPerformance,
  getDailySchedule,
} from '../lib/api';
import { formatPhone } from '../lib/utils';

export default function Intelligence() {
  const [clientId] = useState(() => localStorage.getItem('elyvn_client') || '');
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [intelligence, setIntelligence] = useState(null);
  const [peakHours, setPeakHours] = useState(null);
  const [responseImpact, setResponseImpact] = useState(null);
  const [scores, setScores] = useState([]);
  const [conversion, setConversion] = useState(null);
  const [revenue, setRevenue] = useState(null);
  const [channels, setChannels] = useState([]);
  const [schedule, setSchedule] = useState([]);

  const loadData = useCallback(() => {
    if (!clientId) return;
    setLoading(true);
    setError(null);

    Promise.all([
      getIntelligence(clientId, days).catch(() => null),
      getPeakHours(clientId).catch(() => null),
      getResponseImpact(clientId).catch(() => null),
      getLeadScores(clientId).catch(() => ({ leads: [] })),
      getConversionAnalytics(clientId).catch(() => null),
      getRevenue(clientId, days).catch(() => null),
      getChannelPerformance(clientId).catch(() => ({ channels: [] })),
      getDailySchedule(clientId).catch(() => ({ schedule: [] })),
    ])
      .then(([intel, peaks, impact, scoresData, conv, rev, chans, sched]) => {
        setIntelligence(intel);
        setPeakHours(peaks);
        setResponseImpact(impact);
        setScores(Array.isArray(scoresData) ? scoresData : scoresData?.leads || []);
        setConversion(conv);
        setRevenue(rev);
        setChannels(Array.isArray(chans) ? chans : chans?.channels || []);
        setSchedule(Array.isArray(sched) ? sched : sched?.schedule || []);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message || 'Failed to load intelligence data');
        setLoading(false);
      });
  }, [clientId, days]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, [loadData]);

  // Parse peak hours data to create grid
  const createPeakHoursGrid = () => {
    if (!peakHours) return [];
    const hours = Array.from({ length: 13 }, (_, i) => i + 8); // 8AM-8PM
    const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const data = peakHours.data || [];

    return {
      hours,
      days: daysOfWeek,
      data: hours.map(hour =>
        daysOfWeek.map(day => {
          const point = data.find(d => d.hour === hour && d.day === day);
          return point?.volume || 0;
        })
      ),
    };
  };

  const grid = createPeakHoursGrid();
  const maxVolume = grid.data.length > 0
    ? Math.max(...grid.data.flat())
    : 1;

  if (!clientId) {
    return (
      <div className="fade-in">
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 20 }}>Intelligence</h1>
        <div className="card" style={{ padding: 32, textAlign: 'center', color: '#555' }}>
          No client selected
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600 }}>Intelligence</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          {[30, 60, 90].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={{
                padding: '8px 16px',
                borderRadius: 6,
                border: `1px solid ${days === d ? '#C9A84C' : 'rgba(255,255,255,0.1)'}`,
                background: days === d ? 'rgba(201,168,76,0.15)' : 'transparent',
                color: days === d ? '#C9A84C' : '#888',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div style={{
          padding: '12px 16px',
          background: 'rgba(220,38,38,0.1)',
          border: '1px solid rgba(220,38,38,0.2)',
          borderRadius: 8,
          color: '#DC2626',
          fontSize: 13,
          marginBottom: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>{error}</span>
          <button className="btn-ghost" onClick={loadData} style={{ color: '#DC2626' }}>Retry</button>
        </div>
      )}

      {/* KPI Row */}
      <div className="grid-4" style={{ marginBottom: 28 }}>
        <StatsCard
          title="Booking Rate"
          value={loading ? '--' : `${(intelligence?.booking_rate ?? 0).toFixed(1)}%`}
          icon={Target}
          color="#3B82F6"
        />
        <StatsCard
          title="Avg Response Time"
          value={loading ? '--' : `${responseImpact?.avg_response_time_minutes ?? 0}m`}
          icon={Clock}
          color="#C9A84C"
        />
        <StatsCard
          title="Revenue This Period"
          value={loading ? '--' : `$${(revenue?.total_revenue ?? 0).toLocaleString()}`}
          icon={DollarSign}
          color="#16A34A"
        />
        <StatsCard
          title="ROI Multiplier"
          value={loading ? '--' : `${(revenue?.roi_multiplier ?? 0).toFixed(1)}x`}
          trend={revenue?.roi_trend}
          icon={TrendingUp}
          color="#EAB308"
        />
      </div>

      {/* Coaching Tips */}
      {intelligence?.coaching_tips && intelligence.coaching_tips.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Coaching Tips</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
            {intelligence.coaching_tips.map((tip, i) => (
              <div
                key={i}
                className="card"
                style={{
                  padding: 16,
                  borderLeft: '3px solid #C9A84C',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                }}
              >
                <Brain size={18} color="#C9A84C" style={{ flexShrink: 0, marginTop: 2 }} />
                <p style={{ fontSize: 13, color: '#e0d8c8', lineHeight: 1.5 }}>
                  {tip}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Peak Hours Heatmap */}
      {grid.hours.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Peak Hours</h2>
          <div className="card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', gap: 16 }}>
              {/* Hour labels */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 24 }}>
                {grid.hours.map(h => (
                  <div
                    key={h}
                    style={{
                      fontSize: 11,
                      color: '#555',
                      height: 24,
                      display: 'flex',
                      alignItems: 'center',
                      minWidth: 40,
                    }}
                  >
                    {h}:00
                  </div>
                ))}
              </div>
              {/* Heatmap */}
              <div style={{ flex: 1 }}>
                {/* Day labels */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  {grid.days.map(day => (
                    <div
                      key={day}
                      style={{
                        flex: 1,
                        fontSize: 11,
                        color: '#555',
                        textAlign: 'center',
                      }}
                    >
                      {day}
                    </div>
                  ))}
                </div>
                {/* Grid */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {grid.data.map((row, hourIdx) => (
                    <div key={hourIdx} style={{ display: 'flex', gap: 8 }}>
                      {row.map((volume, dayIdx) => {
                        const intensity = maxVolume > 0 ? volume / maxVolume : 0;
                        const bgColor = intensity === 0
                          ? 'rgba(255,255,255,0.05)'
                          : `rgba(201,168,76,${0.2 + intensity * 0.6})`;
                        return (
                          <div
                            key={dayIdx}
                            style={{
                              flex: 1,
                              height: 24,
                              background: bgColor,
                              borderRadius: 4,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: 10,
                              color: intensity > 0.5 ? '#0d0d0d' : '#888',
                              fontWeight: 500,
                            }}
                            title={`${volume} contacts`}
                          >
                            {volume > 0 ? volume : '-'}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Lead Scoring Table */}
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Top Leads by Score</h2>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: '#555' }}>
            <div className="spinner" /> Loading...
          </div>
        ) : scores.length === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: '#555' }}>
            No lead scores available
          </div>
        ) : (
          <div>
            {scores.slice(0, 10).map((lead, i) => (
              <div
                key={lead.id || lead.lead_id || i}
                className="card"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  padding: '12px 16px',
                  marginBottom: 6,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#141414'}
                onMouseLeave={e => e.currentTarget.style.background = '#0d0d0d'}
              >
                <Target size={16} color="#3B82F6" style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    {lead.name || lead.lead_name || 'Unknown'}
                  </div>
                  <div style={{ fontSize: 11, color: '#555' }}>
                    {formatPhone(lead.phone || lead.phone_number)}
                  </div>
                </div>
                {/* Score bar */}
                <div style={{ width: 120, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        background: '#C9A84C',
                        width: `${Math.min((lead.score || 0) * 10, 100)}%`,
                        transition: 'width 0.3s',
                      }}
                    />
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 500, color: '#C9A84C', minWidth: 30, textAlign: 'right' }}>
                    {(lead.score || 0).toFixed(1)}
                  </span>
                </div>
                {lead.insight && (
                  <span style={{ fontSize: 11, color: '#555', textAlign: 'right', minWidth: 100, marginLeft: 8 }}>
                    {lead.insight}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Channel Performance */}
      {channels.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Channel Performance</h2>
          <div className="card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 20, height: 240 }}>
              {channels.map((channel, i) => {
                const maxVal = Math.max(...channels.map(c => c.volume || 0)) || 1;
                const height = ((channel.volume || 0) / maxVal) * 200;
                return (
                  <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontSize: 11, color: '#555', alignSelf: 'flex-end', height: 20 }}>
                      {channel.volume || 0}
                    </div>
                    <div
                      style={{
                        width: '100%',
                        height,
                        background: '#C9A84C',
                        borderRadius: '4px 4px 0 0',
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = '#d4b86e'}
                      onMouseLeave={e => e.currentTarget.style.background = '#C9A84C'}
                    />
                    <div style={{ fontSize: 12, fontWeight: 500, marginTop: 8 }}>
                      {channel.name || channel.channel}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Today's Schedule */}
      <div>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Today's Contact Schedule</h2>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: '#555' }}>
            <div className="spinner" /> Loading...
          </div>
        ) : schedule.length === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: '#555' }}>
            No scheduled contacts for today
          </div>
        ) : (
          <div>
            {schedule.map((item, i) => (
              <div
                key={item.id || item.contact_id || i}
                className="card"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  padding: '12px 16px',
                  marginBottom: 6,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#141414'}
                onMouseLeave={e => e.currentTarget.style.background = '#0d0d0d'}
              >
                <Calendar size={16} color="#C9A84C" style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    {item.name || item.lead_name || 'Unknown'}
                  </div>
                  <div style={{ fontSize: 11, color: '#555' }}>
                    {formatPhone(item.phone || item.phone_number)} • {item.reason || 'Follow-up'}
                  </div>
                </div>
                <span style={{ fontSize: 12, fontWeight: 500, color: '#C9A84C', minWidth: 60, textAlign: 'right' }}>
                  {item.scheduled_time || item.time || '--:--'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
