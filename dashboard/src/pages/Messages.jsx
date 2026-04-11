import { useState, useEffect, useCallback, useRef } from 'react';
import {
  MessageSquare, Send, Search, ChevronLeft, RefreshCw, Phone, Archive,
  CheckCheck, Check, Clock, AlertTriangle, X
} from 'lucide-react';
import {
  getConversations, getConversationTimeline, sendConversationMessage,
  markConversationRead, archiveConversation
} from '../lib/api';
import { useWebSocket } from '../lib/useWebSocket';
import { formatPhone, timeAgo } from '../lib/utils';

export default function Messages() {
  const clientId = localStorage.getItem('elyvn_client') || '';
  const apiKey = sessionStorage.getItem('elyvn_api_key') || '';
  const { isConnected, lastEvent } = useWebSocket(apiKey);

  // Conversations list
  const [conversations, setConversations] = useState([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  // Active conversation
  const [activeConv, setActiveConv] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [loadingTimeline, setLoadingTimeline] = useState(false);

  // Compose
  const [messageInput, setMessageInput] = useState('');
  const [sending, setSending] = useState(false);

  const timelineEndRef = useRef(null);
  const inputRef = useRef(null);

  // Load conversations
  const loadConversations = useCallback(() => {
    if (!clientId) return;
    setLoadingConvs(true);
    getConversations(clientId, {
      limit: 50,
      status: statusFilter === 'all' ? undefined : statusFilter,
      search: searchQuery || undefined,
    })
      .then(res => {
        setConversations(res.data || []);
        setLoadingConvs(false);
      })
      .catch(() => setLoadingConvs(false));
  }, [clientId, statusFilter, searchQuery]);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  // Load timeline for active conversation
  const loadTimeline = useCallback(() => {
    if (!clientId || !activeConv) return;
    setLoadingTimeline(true);
    getConversationTimeline(clientId, activeConv.id, { limit: 100, include_calls: true })
      .then(res => {
        setTimeline(res.data || []);
        setLoadingTimeline(false);
        // Mark as read
        if (activeConv.unread_count > 0) {
          markConversationRead(clientId, activeConv.id).then(() => {
            setConversations(prev => prev.map(c =>
              c.id === activeConv.id ? { ...c, unread_count: 0 } : c
            ));
          }).catch(() => {});
        }
      })
      .catch(() => setLoadingTimeline(false));
  }, [clientId, activeConv]);

  useEffect(() => { loadTimeline(); }, [loadTimeline]);

  // Auto-scroll timeline
  useEffect(() => {
    if (timelineEndRef.current) {
      timelineEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [timeline]);

  // WebSocket: reload on new messages
  useEffect(() => {
    if (lastEvent?.type === 'new_message') {
      loadConversations();
      if (activeConv && lastEvent.data?.conversationId === activeConv.id) {
        loadTimeline();
      }
    }
  }, [lastEvent]);

  // Send message
  const handleSend = async () => {
    if (!messageInput.trim() || !activeConv || sending) return;
    setSending(true);
    try {
      await sendConversationMessage(clientId, activeConv.id, messageInput.trim());
      setMessageInput('');
      loadTimeline();
      loadConversations();
    } catch (err) {
      // Show inline error
    }
    setSending(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Archive
  const handleArchive = async (convId) => {
    try {
      await archiveConversation(clientId, convId);
      setConversations(prev => prev.filter(c => c.id !== convId));
      if (activeConv?.id === convId) setActiveConv(null);
    } catch (_) {}
  };

  // Delivery status icon
  const DeliveryIcon = ({ status }) => {
    switch (status) {
      case 'delivered': return <CheckCheck size={12} style={{ color: '#4ade80' }} />;
      case 'read': return <CheckCheck size={12} style={{ color: '#60a5fa' }} />;
      case 'failed': return <AlertTriangle size={12} style={{ color: '#f87171' }} />;
      case 'sent': return <Check size={12} style={{ color: '#666' }} />;
      default: return <Clock size={12} style={{ color: '#444' }} />;
    }
  };

  const totalUnread = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);

  return (
    <div style={{ background: '#050505', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ padding: '16px 24px', borderBottom: '1px solid rgba(212,175,55,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', backdropFilter: 'blur(12px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {activeConv && (
            <button onClick={() => setActiveConv(null)} className="btn-ghost" style={{ padding: 4 }}>
              <ChevronLeft size={20} color="#666" />
            </button>
          )}
          <h1 style={{ fontSize: 22, fontWeight: 300, color: '#F5F5F0', margin: 0, fontFamily: "'Cormorant Garamond', Georgia, serif" }}>
            {activeConv ? formatPhone(activeConv.lead_phone) : 'Messages'}
          </h1>
          {activeConv?.lead_name && (
            <span style={{ fontSize: 13, color: '#666' }}>{activeConv.lead_name}</span>
          )}
          {!activeConv && totalUnread > 0 && (
            <span style={{ background: '#D4AF37', color: '#050505', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10 }}>
              {totalUnread}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {activeConv && (
            <button onClick={() => handleArchive(activeConv.id)} className="btn-ghost" style={{ fontSize: 12, color: '#666', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Archive size={14} /> Archive
            </button>
          )}
          <button onClick={activeConv ? loadTimeline : loadConversations} className="btn-ghost" style={{ padding: 4 }}>
            <RefreshCw size={16} color="#666" />
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: isConnected ? '#4ade80' : '#f87171' }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: isConnected ? '#4ade80' : '#f87171', boxShadow: isConnected ? '0 0 8px rgba(74,222,128,0.5)' : 'none' }} />
            {isConnected ? 'Live' : 'Offline'}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Conversation list */}
        <div style={{
          width: activeConv ? 0 : '100%',
          maxWidth: activeConv ? 0 : '100%',
          minWidth: activeConv ? 0 : undefined,
          overflow: 'hidden',
          transition: 'width 0.2s, max-width 0.2s',
          borderRight: '1px solid rgba(212,175,55,0.12)',
          display: 'flex',
          flexDirection: 'column',
          ...(typeof window !== 'undefined' && window.innerWidth >= 768 ? {
            width: activeConv ? 340 : '100%',
            maxWidth: activeConv ? 340 : '100%',
            minWidth: activeConv ? 340 : undefined,
          } : {}),
        }}>
          {/* Search + Filter */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(212,175,55,0.08)' }}>
            <div style={{ position: 'relative', marginBottom: 8 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: 9, color: '#444' }} />
              <input
                type="text"
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{ width: '100%', paddingLeft: 32, padding: '10px 14px 10px 32px', background: '#0a0a0a', border: '1px solid rgba(212,175,55,0.12)', borderRadius: 14, color: '#F5F5F0', fontSize: 12, outline: 'none' }}
              />
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {['all', 'active', 'archived'].map(s => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  style={{
                    padding: '5px 12px', fontSize: 11, borderRadius: 10, border: 'none', cursor: 'pointer',
                    background: statusFilter === s ? '#D4AF37' : 'rgba(212,175,55,0.06)',
                    color: statusFilter === s ? '#050505' : '#666',
                    fontWeight: statusFilter === s ? 600 : 400,
                  }}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Conversation rows */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loadingConvs ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#444' }}>
                <div className="spinner" style={{ margin: '0 auto 8px' }} />
                Loading...
              </div>
            ) : conversations.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#444', fontSize: 13 }}>
                No conversations yet
              </div>
            ) : conversations.map(conv => (
              <div
                key={conv.id}
                onClick={() => setActiveConv(conv)}
                style={{
                  padding: '12px 16px', borderBottom: '1px solid rgba(212,175,55,0.06)', cursor: 'pointer',
                  background: activeConv?.id === conv.id ? 'rgba(212,175,55,0.06)' : 'transparent',
                  borderLeft: activeConv?.id === conv.id ? '2px solid #D4AF37' : '2px solid transparent',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => { if (activeConv?.id !== conv.id) e.currentTarget.style.background = '#0f0f0f'; }}
                onMouseLeave={e => { if (activeConv?.id !== conv.id) e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#F5F5F0' }}>
                      {conv.lead_name || formatPhone(conv.lead_phone)}
                    </span>
                    {conv.unread_count > 0 && (
                      <span style={{ background: '#D4AF37', color: '#050505', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8, minWidth: 16, textAlign: 'center' }}>
                        {conv.unread_count}
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 11, color: '#444', whiteSpace: 'nowrap' }}>
                    {conv.last_message_at ? timeAgo(new Date(conv.last_message_at)) : ''}
                  </span>
                </div>
                {conv.lead_name && (
                  <div style={{ fontSize: 11, color: '#666', marginBottom: 2 }}>
                    {formatPhone(conv.lead_phone)}
                  </div>
                )}
                <div style={{ fontSize: 12, color: conv.unread_count > 0 ? '#F5F5F0' : '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: conv.unread_count > 0 ? 500 : 400 }}>
                  {conv.last_message_preview || 'No messages'}
                </div>
                {conv.lead_stage && (
                  <span style={{ fontSize: 10, color: '#666', background: 'rgba(212,175,55,0.06)', padding: '2px 6px', borderRadius: 6, marginTop: 4, display: 'inline-block' }}>
                    {conv.lead_stage}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Timeline + Compose */}
        {activeConv ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {/* Timeline */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
              {loadingTimeline ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#555' }}>
                  <div className="spinner" style={{ margin: '0 auto 8px' }} />
                  Loading timeline...
                </div>
              ) : timeline.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#555', fontSize: 13 }}>
                  No messages in this conversation
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {timeline.map((entry, i) => {
                    // Call entry
                    if (entry.entry_type === 'call') {
                      return (
                        <div key={entry.id || i} style={{
                          alignSelf: 'center', background: 'rgba(212,175,55,0.04)', border: '1px solid rgba(212,175,55,0.12)',
                          padding: '8px 16px', borderRadius: 20, display: 'flex', alignItems: 'center', gap: 8,
                          fontSize: 12, color: '#666', margin: '8px 0',
                        }}>
                          <Phone size={12} />
                          <span>{entry.direction === 'inbound' ? 'Incoming' : 'Outgoing'} call</span>
                          {entry.duration != null && <span>({Math.round(entry.duration / 60)}m {entry.duration % 60}s)</span>}
                          {entry.outcome && <span style={{ color: entry.outcome === 'booked' ? '#4ade80' : '#F5F5F0', fontWeight: 500 }}>- {entry.outcome}</span>}
                          {entry.score != null && <span style={{ color: '#D4AF37' }}>{entry.score}pts</span>}
                          <span style={{ color: '#444' }}>{entry.created_at ? timeAgo(new Date(entry.created_at)) : ''}</span>
                        </div>
                      );
                    }

                    // Message entry
                    const isOutbound = entry.direction === 'outbound';
                    return (
                      <div key={entry.id || i} style={{ alignSelf: isOutbound ? 'flex-end' : 'flex-start', maxWidth: '75%' }}>
                        <div style={{
                          background: isOutbound ? 'rgba(212,175,55,0.08)' : 'rgba(255,255,255,0.02)',
                          border: isOutbound ? '1px solid rgba(212,175,55,0.2)' : '1px solid rgba(212,175,55,0.08)',
                          padding: '10px 14px', borderRadius: 14,
                          borderBottomRightRadius: isOutbound ? 2 : 12,
                          borderBottomLeftRadius: isOutbound ? 12 : 2,
                        }}>
                          {!isOutbound && entry.status === 'auto_replied' && (
                            <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>Customer</div>
                          )}
                          {isOutbound && (
                            <div style={{ fontSize: 10, color: '#D4AF37', marginBottom: 4, fontWeight: 600 }}>
                              {entry.status === 'manual_reply' ? 'You' : 'Elyvn AI'}
                            </div>
                          )}
                          <div style={{ fontSize: 13, color: '#F5F5F0', lineHeight: 1.5, wordBreak: 'break-word' }}>
                            {entry.body || '(empty)'}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, justifyContent: isOutbound ? 'flex-end' : 'flex-start' }}>
                            <span style={{ fontSize: 10, color: '#444' }}>
                              {entry.created_at ? new Date(entry.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                            </span>
                            {entry.channel && entry.channel !== 'sms' && (
                              <span style={{ fontSize: 10, color: '#444', background: 'rgba(212,175,55,0.06)', padding: '1px 4px', borderRadius: 6 }}>
                                {entry.channel}
                              </span>
                            )}
                            {isOutbound && <DeliveryIcon status={entry.delivery_status} />}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={timelineEndRef} />
                </div>
              )}
            </div>

            {/* Compose bar */}
            <div style={{ padding: '12px 20px', borderTop: '1px solid rgba(212,175,55,0.12)', background: 'rgba(17,17,17,0.8)', backdropFilter: 'blur(12px)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <textarea
                  ref={inputRef}
                  value={messageInput}
                  onChange={e => setMessageInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a message..."
                  rows={1}
                  style={{
                    flex: 1, padding: '10px 14px', background: '#0a0a0a', border: '1px solid rgba(212,175,55,0.12)',
                    borderRadius: 14, color: '#F5F5F0', fontSize: 13, outline: 'none', resize: 'none',
                    lineHeight: 1.4, minHeight: 40, maxHeight: 120, fontFamily: 'inherit',
                  }}
                />
                <button
                  onClick={handleSend}
                  disabled={!messageInput.trim() || sending}
                  style={{
                    padding: '10px 16px', background: messageInput.trim() ? 'linear-gradient(135deg, #EED07A, #D4AF37, #9A7840)' : 'rgba(212,175,55,0.06)',
                    border: 'none', borderRadius: 14, cursor: messageInput.trim() ? 'pointer' : 'default',
                    display: 'flex', alignItems: 'center', gap: 6, color: messageInput.trim() ? '#050505' : '#444',
                    fontWeight: 600, fontSize: 13, transition: 'all 0.3s cubic-bezier(0.22,1,0.36,1)',
                    opacity: sending ? 0.5 : 1,
                  }}
                >
                  <Send size={14} />
                  {sending ? 'Sending...' : 'Send'}
                </button>
              </div>
              <div style={{ fontSize: 10, color: '#444', marginTop: 4 }}>
                {messageInput.length}/1600 chars  |  Press Enter to send
              </div>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#444' }}>
            <div style={{ textAlign: 'center' }}>
              <MessageSquare size={48} style={{ marginBottom: 16, opacity: 0.2, color: '#D4AF37' }} />
              <div style={{ fontSize: 14, color: '#444' }}>Select a conversation</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
