import { useState, useEffect, useCallback } from 'react';
import { MessageSquare, Zap, AlertTriangle, BarChart3, X, Search, ChevronLeft, ChevronRight, Filter, RefreshCw } from 'lucide-react';
import { getMessages } from '../lib/api';
import { useWebSocket } from '../lib/useWebSocket';
import { formatPhone, timeAgo, truncate } from '../lib/utils';

export default function Messages() {
  const clientId = localStorage.getItem('elyvn_client') || '';
  const apiKey = sessionStorage.getItem('elyvn_api_key') || '';
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // WebSocket integration
  const { isConnected, lastEvent } = useWebSocket(apiKey);

  // Filters
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState('all');
  const [direction, setDirection] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  // Detail modal
  const [selectedMessage, setSelectedMessage] = useState(null);

  const loadMessages = useCallback(() => {
    if (!clientId) return;
    setLoading(true);
    setError(null);

    getMessages(clientId, {
      page,
      limit: 20,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      status: status === 'all' ? undefined : status,
      direction: direction === 'all' ? undefined : direction,
    })
      .then(data => {
        const list = Array.isArray(data) ? data : data.messages || [];
        setMessages(list);
        setTotalPages(data.total_pages || Math.ceil((data.total || list.length) / 20) || 1);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message || 'Failed to load messages');
        setLoading(false);
      });
  }, [clientId, page, startDate, endDate, status, direction]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Listen for WebSocket updates
  useEffect(() => {
    if (lastEvent && lastEvent.type === 'new_message') {
      setTimeout(() => loadMessages(), 500);
    }
  }, [lastEvent, loadMessages]);

  const handleApplyFilters = () => {
    setPage(1);
    loadMessages();
    setShowFilters(false);
  };

  const handleClearFilters = () => {
    setStartDate('');
    setEndDate('');
    setStatus('all');
    setDirection('all');
    setSearchQuery('');
    setPage(1);
  };

  // Calculate stats
  const totalCount = messages.length;
  const autoRepliedCount = messages.filter(m => m.status === 'auto_replied').length;
  const escalatedCount = messages.filter(m => m.escalated === true || m.status === 'escalated').length;
  const responseRate = totalCount > 0 ? Math.round((autoRepliedCount / totalCount) * 100) : 0;

  // Filter messages by search query
  const filteredMessages = searchQuery
    ? messages.filter(m => {
        const phone = (m.phone_number || m.phone || '').toLowerCase();
        const content = (m.message || m.content || '').toLowerCase();
        const query = searchQuery.toLowerCase();
        return phone.includes(query) || content.includes(query);
      })
    : messages;

  const getStatusBadge = (msg) => {
    let color = '#555';
    let icon = null;
    let label = 'Pending';

    if (msg.status === 'auto_replied' || msg.escalated === false) {
      color = '#16A34A';
      label = 'Auto-Replied';
    } else if (msg.escalated === true || msg.status === 'escalated') {
      color = '#FBBF24';
      label = 'Escalated';
    } else if (msg.status === 'failed') {
      color = '#DC2626';
      label = 'Failed';
    }

    return { color, label };
  };

  return (
    <div style={{ background: '#0a0a0a', minHeight: '100vh', paddingBottom: 40 }}>
      {/* Header */}
      <div style={{ padding: '24px 24px 0', background: '#0a0a0a' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: '#e0d8c8', margin: 0 }}>Messages</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              className="btn-ghost"
              onClick={loadMessages}
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#888' }}
            >
              <RefreshCw size={16} /> Refresh
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: isConnected ? '#16A34A' : '#DC2626' }}>
              <div style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: isConnected ? '#16A34A' : '#DC2626',
                boxShadow: isConnected ? '0 0 8px #16A34A' : 'none',
              }} />
              {isConnected ? 'Live' : 'Offline'}
            </div>
          </div>
        </div>

        {/* Stats Bar */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 24 }}>
          {/* Total Messages */}
          <div className="card" style={{ background: '#0d0d0d', border: '1px solid #222', padding: 16, borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <div style={{ background: '#C9A84C', padding: 8, borderRadius: 6, color: '#0a0a0a' }}>
                <MessageSquare size={16} />
              </div>
              <span style={{ fontSize: 12, color: '#888' }}>Total Messages</span>
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#e0d8c8' }}>{totalCount}</div>
          </div>

          {/* Auto-Replied */}
          <div className="card" style={{ background: '#0d0d0d', border: '1px solid #222', padding: 16, borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <div style={{ background: '#16A34A', padding: 8, borderRadius: 6, color: '#0a0a0a' }}>
                <Zap size={16} />
              </div>
              <span style={{ fontSize: 12, color: '#888' }}>Auto-Replied</span>
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#e0d8c8' }}>{autoRepliedCount}</div>
          </div>

          {/* Escalated */}
          <div className="card" style={{ background: '#0d0d0d', border: '1px solid #222', padding: 16, borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <div style={{ background: '#FBBF24', padding: 8, borderRadius: 6, color: '#0a0a0a' }}>
                <AlertTriangle size={16} />
              </div>
              <span style={{ fontSize: 12, color: '#888' }}>Escalated</span>
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#e0d8c8' }}>{escalatedCount}</div>
          </div>

          {/* Response Rate */}
          <div className="card" style={{ background: '#0d0d0d', border: '1px solid #222', padding: 16, borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <div style={{ background: '#8B5CF6', padding: 8, borderRadius: 6, color: '#0a0a0a' }}>
                <BarChart3 size={16} />
              </div>
              <span style={{ fontSize: 12, color: '#888' }}>Response Rate</span>
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#e0d8c8' }}>{responseRate}%</div>
          </div>
        </div>
      </div>

      {/* Search Bar */}
      <div style={{ padding: '0 24px', marginBottom: 20 }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search size={16} style={{ position: 'absolute', left: 12, color: '#555', pointerEvents: 'none' }} />
          <input
            type="text"
            placeholder="Search by phone or message..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{
              width: '100%',
              paddingLeft: 40,
              paddingRight: 12,
              paddingTop: 10,
              paddingBottom: 10,
              background: '#0d0d0d',
              border: '1px solid #222',
              borderRadius: 8,
              color: '#e0d8c8',
              fontSize: 13,
              outline: 'none',
            }}
          />
        </div>
      </div>

      {/* Filters Card */}
      <div style={{ padding: '0 24px', marginBottom: 24 }}>
        <div className="card" style={{ background: '#0d0d0d', border: '1px solid #222', borderRadius: 8, overflow: 'hidden' }}>
          <button
            onClick={() => setShowFilters(!showFilters)}
            style={{
              width: '100%',
              padding: '12px 16px',
              background: '#0d0d0d',
              border: 'none',
              color: '#e0d8c8',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              transition: 'background 0.2s',
            }}
            onMouseEnter={e => e.target.style.background = '#141414'}
            onMouseLeave={e => e.target.style.background = '#0d0d0d'}
          >
            <Filter size={16} />
            {showFilters ? 'Hide Filters' : 'Show Filters'}
          </button>

          {showFilters && (
            <div style={{ padding: 16, borderTop: '1px solid #222', background: '#0a0a0a' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 16 }}>
                {/* Date Range */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 6 }}>From Date</label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={e => setStartDate(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      background: '#141414',
                      border: '1px solid #222',
                      borderRadius: 6,
                      color: '#e0d8c8',
                      fontSize: 12,
                      outline: 'none',
                    }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 6 }}>To Date</label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={e => setEndDate(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      background: '#141414',
                      border: '1px solid #222',
                      borderRadius: 6,
                      color: '#e0d8c8',
                      fontSize: 12,
                      outline: 'none',
                    }}
                  />
                </div>

                {/* Status Filter */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 6 }}>Status</label>
                  <select
                    value={status}
                    onChange={e => setStatus(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      background: '#141414',
                      border: '1px solid #222',
                      borderRadius: 6,
                      color: '#e0d8c8',
                      fontSize: 12,
                      outline: 'none',
                    }}
                  >
                    <option value="all">All Status</option>
                    <option value="auto_replied">Auto Replied</option>
                    <option value="escalated">Escalated</option>
                    <option value="failed">Failed</option>
                  </select>
                </div>

                {/* Direction Filter */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 6 }}>Direction</label>
                  <select
                    value={direction}
                    onChange={e => setDirection(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      background: '#141414',
                      border: '1px solid #222',
                      borderRadius: 6,
                      color: '#e0d8c8',
                      fontSize: 12,
                      outline: 'none',
                    }}
                  >
                    <option value="all">All Directions</option>
                    <option value="inbound">Inbound</option>
                    <option value="outbound">Outbound</option>
                  </select>
                </div>
              </div>

              {/* Filter Actions */}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  className="btn-ghost"
                  onClick={handleClearFilters}
                  style={{ fontSize: 12, color: '#888' }}
                >
                  Clear Filters
                </button>
                <button
                  className="btn-primary"
                  onClick={handleApplyFilters}
                  style={{ fontSize: 12 }}
                >
                  Apply Filters
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          margin: '0 24px 20px',
          padding: '12px 16px',
          background: 'rgba(220,38,38,0.1)',
          border: '1px solid rgba(220,38,38,0.2)',
          borderRadius: 8,
          color: '#DC2626',
          fontSize: 13,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>{error}</span>
          <button className="btn-ghost" onClick={loadMessages} style={{ color: '#DC2626', fontSize: 12 }}>Retry</button>
        </div>
      )}

      {/* Content */}
      <div style={{ padding: '0 24px' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 40, color: '#555', justifyContent: 'center' }}>
            <div className="spinner" />
            <span>Loading messages...</span>
          </div>
        ) : filteredMessages.length === 0 ? (
          <div className="card" style={{ background: '#0d0d0d', border: '1px solid #222', padding: 40, textAlign: 'center', color: '#555', borderRadius: 8 }}>
            {searchQuery ? 'No messages match your search' : 'No messages found'}
          </div>
        ) : (
          <div className="card" style={{ background: '#0d0d0d', border: '1px solid #222', borderRadius: 8, overflow: 'hidden' }}>
            {/* Table Header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '80px 120px 1fr 1fr 100px 90px',
              gap: 12,
              padding: '12px 16px',
              background: '#141414',
              borderBottom: '1px solid #222',
              fontSize: 11,
              color: '#888',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}>
              <div>Time</div>
              <div>Phone</div>
              <div>Message</div>
              <div>Reply</div>
              <div>Status</div>
              <div>Source</div>
            </div>

            {/* Message Rows */}
            {filteredMessages.map((msg, i) => {
              const badge = getStatusBadge(msg);
              const msgTime = msg.timestamp ? timeAgo(new Date(msg.timestamp)) : '—';
              const phone = formatPhone(msg.phone_number || msg.phone || '');
              const msgContent = truncate(msg.message || msg.content || '', 60);
              const replyContent = msg.ai_reply ? truncate(msg.ai_reply, 60) : (msg.reply ? truncate(msg.reply, 60) : '—');
              const source = msg.source || 'SMS';

              return (
                <div
                  key={msg.id || msg.message_id || i}
                  onClick={() => setSelectedMessage(msg)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '80px 120px 1fr 1fr 100px 90px',
                    gap: 12,
                    padding: '12px 16px',
                    borderBottom: '1px solid #222',
                    alignItems: 'center',
                    cursor: 'pointer',
                    transition: 'background 0.2s',
                    background: '#0d0d0d',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = '#141414'}
                  onMouseLeave={e => e.currentTarget.style.background = '#0d0d0d'}
                >
                  <div style={{ fontSize: 12, color: '#888' }}>{msgTime}</div>
                  <div style={{ fontSize: 12, color: '#e0d8c8', fontWeight: 500 }}>{phone}</div>
                  <div style={{ fontSize: 12, color: '#e0d8c8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {msgContent}
                  </div>
                  <div style={{ fontSize: 12, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {replyContent}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: badge.color }}>
                    {badge.label}
                  </div>
                  <div style={{ fontSize: 11, color: '#888', background: '#141414', padding: '4px 8px', borderRadius: 4, textAlign: 'center' }}>
                    {source}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {!loading && filteredMessages.length > 0 && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          marginTop: 24,
          padding: '0 24px',
        }}>
          <button
            className="btn-ghost"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            style={{ opacity: page <= 1 ? 0.3 : 1, cursor: page <= 1 ? 'default' : 'pointer' }}
          >
            <ChevronLeft size={16} />
          </button>
          <span style={{ fontSize: 13, color: '#888' }}>
            Page <span style={{ color: '#e0d8c8', fontWeight: 600 }}>{page}</span> of <span style={{ color: '#e0d8c8', fontWeight: 600 }}>{totalPages}</span>
          </span>
          <button
            className="btn-ghost"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            style={{ opacity: page >= totalPages ? 0.3 : 1, cursor: page >= totalPages ? 'default' : 'pointer' }}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      {/* Detail Modal */}
      {selectedMessage && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 50,
          padding: 20,
        }}>
          <div style={{
            background: '#0d0d0d',
            border: '1px solid #222',
            borderRadius: 12,
            maxWidth: 600,
            width: '100%',
            maxHeight: '90vh',
            overflow: 'auto',
            boxShadow: '0 20px 60px rgba(0,0,0,0.8)',
          }}>
            {/* Modal Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: '1px solid #222',
              background: '#141414',
            }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: '#e0d8c8', margin: 0 }}>
                Conversation
              </h2>
              <button
                onClick={() => setSelectedMessage(null)}
                className="btn-ghost"
                style={{ fontSize: 0, padding: 4, color: '#888' }}
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal Content */}
            <div style={{ padding: 20 }}>
              {/* Contact Info */}
              <div style={{
                background: '#141414',
                padding: 12,
                borderRadius: 8,
                marginBottom: 20,
                border: '1px solid #222',
              }}>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Phone</div>
                <div style={{ fontSize: 16, fontWeight: 600, color: '#e0d8c8', marginBottom: 12 }}>
                  {formatPhone(selectedMessage.phone_number || selectedMessage.phone || '')}
                </div>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Received</div>
                <div style={{ fontSize: 13, color: '#e0d8c8', marginBottom: 12 }}>
                  {selectedMessage.timestamp ? new Date(selectedMessage.timestamp).toLocaleString() : '—'}
                </div>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Status</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: getStatusBadge(selectedMessage).color }}>
                  {getStatusBadge(selectedMessage).label}
                </div>
              </div>

              {/* Conversation Thread */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
                {/* Inbound Message */}
                <div style={{
                  alignSelf: 'flex-start',
                  maxWidth: '85%',
                  background: '#141414',
                  border: '1px solid #222',
                  padding: 12,
                  borderRadius: 8,
                  borderBottomLeftRadius: 2,
                }}>
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>Customer</div>
                  <div style={{ fontSize: 13, color: '#e0d8c8', lineHeight: 1.5 }}>
                    {selectedMessage.message || selectedMessage.content || '(no content)'}
                  </div>
                </div>

                {/* AI Reply */}
                {(selectedMessage.ai_reply || selectedMessage.reply) && (
                  <div style={{
                    alignSelf: 'flex-end',
                    maxWidth: '85%',
                    background: 'rgba(201, 168, 76, 0.15)',
                    border: '1px solid rgba(201, 168, 76, 0.3)',
                    padding: 12,
                    borderRadius: 8,
                    borderBottomRightRadius: 2,
                  }}>
                    <div style={{ fontSize: 11, color: '#C9A84C', marginBottom: 6, fontWeight: 600 }}>Elyvn AI</div>
                    <div style={{ fontSize: 13, color: '#e0d8c8', lineHeight: 1.5 }}>
                      {selectedMessage.ai_reply || selectedMessage.reply}
                    </div>
                  </div>
                )}

                {/* Escalation Note */}
                {(selectedMessage.escalated === true || selectedMessage.status === 'escalated') && (
                  <div style={{
                    background: 'rgba(251, 191, 36, 0.1)',
                    border: '1px solid rgba(251, 191, 36, 0.3)',
                    padding: 12,
                    borderRadius: 8,
                    marginTop: 8,
                  }}>
                    <div style={{ fontSize: 12, color: '#FBBF24', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <AlertTriangle size={14} />
                      Escalated for Manual Review
                    </div>
                    {selectedMessage.escalation_reason && (
                      <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>
                        {selectedMessage.escalation_reason}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Close Button */}
              <button
                onClick={() => setSelectedMessage(null)}
                className="btn-primary"
                style={{ width: '100%', padding: '10px 16px', fontSize: 13 }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
