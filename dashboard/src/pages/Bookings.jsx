import React, { useState, useEffect, useCallback } from 'react';
import {
  Calendar,
  Clock,
  MapPin,
  User,
  Phone,
  Check,
  X,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { getBookings } from '../lib/api';

const Bookings = () => {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [startDate, setStartDate] = useState(getDefaultStartDate());
  const [endDate, setEndDate] = useState(getDefaultEndDate());
  const [currentWeekStart, setCurrentWeekStart] = useState(getMondayOfWeek(new Date()));

  const clientId = localStorage.getItem('elyvn_client');

  function getDefaultStartDate() {
    const date = new Date();
    date.setDate(date.getDate() - 7);
    return date.toISOString().split('T')[0];
  }

  function getDefaultEndDate() {
    return new Date().toISOString().split('T')[0];
  }

  function getMondayOfWeek(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
  }

  const fetchBookings = useCallback(async () => {
    if (!clientId) {
      setError('Client ID not found');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const data = await getBookings(clientId, startDate, endDate);
      setBookings(data || []);
    } catch (err) {
      setError(err.message || 'Failed to load bookings');
    } finally {
      setLoading(false);
    }
  }, [clientId, startDate, endDate]);

  useEffect(() => {
    fetchBookings();
  }, [fetchBookings]);

  const handleRetry = () => {
    fetchBookings();
  };

  const handlePreviousWeek = () => {
    const newDate = new Date(currentWeekStart);
    newDate.setDate(newDate.getDate() - 7);
    setCurrentWeekStart(newDate);
  };

  const handleNextWeek = () => {
    const newDate = new Date(currentWeekStart);
    newDate.setDate(newDate.getDate() + 7);
    setCurrentWeekStart(newDate);
  };

  // Calculate stats
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const statsData = {
    total: bookings.length,
    upcomingToday: bookings.filter(b => {
      const bookingDate = new Date(b.start_time);
      return bookingDate >= todayStart && bookingDate <= todayEnd && b.status === 'upcoming';
    }).length,
    completed: bookings.filter(b => b.status === 'completed').length,
    cancelled: bookings.filter(b => b.status === 'cancelled').length,
  };

  // Get week days
  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(currentWeekStart);
    day.setDate(day.getDate() + i);
    weekDays.push(day);
  }

  // Get hour slots (8am to 6pm)
  const hourSlots = Array.from({ length: 11 }, (_, i) => 8 + i);

  // Organize bookings by week
  const weekBookings = {};
  weekDays.forEach(day => {
    const dayKey = day.toISOString().split('T')[0];
    weekBookings[dayKey] = bookings.filter(b => {
      const bDate = new Date(b.start_time).toISOString().split('T')[0];
      return bDate === dayKey;
    });
  });

  const getBookingColor = (status) => {
    switch (status) {
      case 'upcoming':
        return '#C9A84C';
      case 'completed':
        return '#16A34A';
      case 'cancelled':
        return '#DC2626';
      default:
        return '#888';
    }
  };

  const getBookingPosition = (startTime, endTime) => {
    const start = new Date(startTime);
    const end = new Date(endTime);
    const hour = start.getHours();
    const minutes = start.getMinutes();
    const duration = (end - start) / (1000 * 60); // minutes
    const top = (minutes / 60) * 60; // pixels per hour = 60
    const height = Math.max((duration / 60) * 60, 30);
    return { top, height };
  };

  const formatTime = (dateTime) => {
    return new Date(dateTime).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digits',
      hour12: true,
    });
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  };

  const formatFullDateTime = (dateTime) => {
    const date = new Date(dateTime);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digits',
      hour12: true,
    });
  };

  const getStatusBadge = (status) => {
    const statusConfig = {
      upcoming: { bg: 'rgba(201, 168, 76, 0.1)', color: '#C9A84C', icon: Clock },
      completed: { bg: 'rgba(22, 163, 74, 0.1)', color: '#16A34A', icon: Check },
      cancelled: { bg: 'rgba(220, 38, 38, 0.1)', color: '#DC2626', icon: X },
      'no-show': { bg: 'rgba(136, 136, 136, 0.1)', color: '#888', icon: X },
    };

    const config = statusConfig[status] || statusConfig.upcoming;
    const IconComponent = config.icon;

    return (
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 12px',
          backgroundColor: config.bg,
          color: config.color,
          borderRadius: '6px',
          fontSize: '12px',
          fontWeight: '500',
          textTransform: 'capitalize',
        }}
      >
        <IconComponent size={14} />
        {status}
      </div>
    );
  };

  return (
    <div style={{ padding: '24px', backgroundColor: '#0a0a0a', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ marginBottom: '32px' }}>
        <h1
          style={{
            fontSize: '22px',
            fontWeight: '600',
            color: 'white',
            margin: '0 0 16px 0',
          }}
        >
          Bookings
        </h1>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end' }}>
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '12px',
                color: '#888',
                marginBottom: '8px',
                fontWeight: '500',
              }}
            >
              Start Date
            </label>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              style={{
                padding: '10px 12px',
                backgroundColor: '#0d0d0d',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                borderRadius: '8px',
                color: 'white',
                fontSize: '13px',
                fontFamily: 'inherit',
              }}
            />
          </div>
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '12px',
                color: '#888',
                marginBottom: '8px',
                fontWeight: '500',
              }}
            >
              End Date
            </label>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              style={{
                padding: '10px 12px',
                backgroundColor: '#0d0d0d',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                borderRadius: '8px',
                color: 'white',
                fontSize: '13px',
                fontFamily: 'inherit',
              }}
            />
          </div>
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: '24px',
            padding: '16px',
            backgroundColor: 'rgba(220, 38, 38, 0.1)',
            border: '1px solid rgba(220, 38, 38, 0.3)',
            borderRadius: '12px',
            color: '#fca5a5',
            fontSize: '13px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{error}</span>
          <button
            onClick={handleRetry}
            style={{
              padding: '8px 16px',
              backgroundColor: 'rgba(220, 38, 38, 0.2)',
              border: '1px solid rgba(220, 38, 38, 0.5)',
              borderRadius: '6px',
              color: '#fca5a5',
              fontSize: '12px',
              fontWeight: '500',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={e => {
              e.target.style.backgroundColor = 'rgba(220, 38, 38, 0.3)';
            }}
            onMouseLeave={e => {
              e.target.style.backgroundColor = 'rgba(220, 38, 38, 0.2)';
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Stats Row */}
      {!loading && !error && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '16px',
            marginBottom: '32px',
          }}
          className="fade-in"
        >
          <StatCard label="Total Bookings" value={statsData.total} />
          <StatCard label="Upcoming Today" value={statsData.upcomingToday} color="#C9A84C" />
          <StatCard label="Completed" value={statsData.completed} color="#16A34A" />
          <StatCard label="Cancelled" value={statsData.cancelled} color="#DC2626" />
        </div>
      )}

      {/* Loading Skeleton */}
      {loading && (
        <div style={{ marginBottom: '32px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
            {[1, 2, 3, 4].map(i => (
              <div
                key={i}
                style={{
                  height: '100px',
                  backgroundColor: '#0d0d0d',
                  borderRadius: '12px',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                  animation: 'pulse 2s infinite',
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Week View Calendar */}
      {!loading && !error && bookings.length > 0 && (
        <div style={{ marginBottom: '32px' }} className="fade-in">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '16px',
            }}
          >
            <h2 style={{ fontSize: '15px', fontWeight: '600', color: 'white', margin: 0 }}>
              Week View
            </h2>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={handlePreviousWeek}
                style={{
                  padding: '8px 12px',
                  backgroundColor: '#0d0d0d',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                  borderRadius: '8px',
                  color: 'white',
                  cursor: 'pointer',
                  fontSize: '13px',
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={e => {
                  e.target.style.backgroundColor = 'rgba(201, 168, 76, 0.1)';
                  e.target.style.borderColor = 'rgba(201, 168, 76, 0.3)';
                }}
                onMouseLeave={e => {
                  e.target.style.backgroundColor = '#0d0d0d';
                  e.target.style.borderColor = 'rgba(255, 255, 255, 0.06)';
                }}
              >
                <ChevronLeft size={16} style={{ display: 'inline' }} />
              </button>
              <button
                onClick={handleNextWeek}
                style={{
                  padding: '8px 12px',
                  backgroundColor: '#0d0d0d',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                  borderRadius: '8px',
                  color: 'white',
                  cursor: 'pointer',
                  fontSize: '13px',
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={e => {
                  e.target.style.backgroundColor = 'rgba(201, 168, 76, 0.1)';
                  e.target.style.borderColor = 'rgba(201, 168, 76, 0.3)';
                }}
                onMouseLeave={e => {
                  e.target.style.backgroundColor = '#0d0d0d';
                  e.target.style.borderColor = 'rgba(255, 255, 255, 0.06)';
                }}
              >
                <ChevronRight size={16} style={{ display: 'inline' }} />
              </button>
            </div>
          </div>

          <div
            style={{
              backgroundColor: '#0d0d0d',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: '12px',
              overflow: 'hidden',
            }}
          >
            {/* Day Headers */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto ' + weekDays.map(() => '1fr').join(' '),
                borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
              }}
            >
              <div style={{ width: '80px', padding: '12px', backgroundColor: '#0a0a0a' }} />
              {weekDays.map((day, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: '12px',
                    backgroundColor: '#0a0a0a',
                    textAlign: 'center',
                    borderRight:
                      idx < weekDays.length - 1 ? '1px solid rgba(255, 255, 255, 0.06)' : 'none',
                  }}
                >
                  <div style={{ fontSize: '12px', color: '#888', fontWeight: '500' }}>
                    {day.toLocaleDateString('en-US', { weekday: 'short' })}
                  </div>
                  <div style={{ fontSize: '13px', color: 'white', fontWeight: '600' }}>
                    {day.getDate()}
                  </div>
                </div>
              ))}
            </div>

            {/* Time Grid */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto ' + weekDays.map(() => '1fr').join(' '),
              }}
            >
              {/* Time Labels */}
              <div style={{ width: '80px', backgroundColor: '#0a0a0a' }}>
                {hourSlots.map(hour => (
                  <div
                    key={hour}
                    style={{
                      height: '60px',
                      padding: '8px',
                      fontSize: '12px',
                      color: '#888',
                      borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                      textAlign: 'right',
                    }}
                  >
                    {hour > 12 ? hour - 12 : hour}
                    {hour >= 12 ? 'pm' : 'am'}
                  </div>
                ))}
              </div>

              {/* Booking Cells */}
              {weekDays.map((day, dayIdx) => {
                const dayKey = day.toISOString().split('T')[0];
                const dayBookings = weekBookings[dayKey] || [];

                return (
                  <div
                    key={dayIdx}
                    style={{
                      position: 'relative',
                      borderRight:
                        dayIdx < weekDays.length - 1 ? '1px solid rgba(255, 255, 255, 0.06)' : 'none',
                    }}
                  >
                    {hourSlots.map(hour => (
                      <div
                        key={hour}
                        style={{
                          height: '60px',
                          borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                          position: 'relative',
                        }}
                      >
                        {dayBookings.map(booking => {
                          const bookingStart = new Date(booking.start_time);
                          if (bookingStart.getHours() === hour) {
                            const { top, height } = getBookingPosition(
                              booking.start_time,
                              booking.end_time
                            );
                            return (
                              <div
                                key={booking.id}
                                style={{
                                  position: 'absolute',
                                  top: `${top}px`,
                                  height: `${height}px`,
                                  left: '4px',
                                  right: '4px',
                                  backgroundColor: getBookingColor(booking.status),
                                  borderRadius: '6px',
                                  padding: '6px',
                                  fontSize: '11px',
                                  color: '#0a0a0a',
                                  fontWeight: '600',
                                  overflow: 'hidden',
                                  cursor: 'pointer',
                                  transition: 'all 0.2s ease',
                                  zIndex: 10,
                                }}
                                onMouseEnter={e => {
                                  e.currentTarget.style.transform = 'scale(1.05)';
                                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5)';
                                }}
                                onMouseLeave={e => {
                                  e.currentTarget.style.transform = 'scale(1)';
                                  e.currentTarget.style.boxShadow = 'none';
                                }}
                                title={booking.name}
                              >
                                <div>{booking.name}</div>
                                <div style={{ fontSize: '10px', opacity: 0.9 }}>
                                  {formatTime(booking.start_time)}
                                </div>
                              </div>
                            );
                          }
                          return null;
                        })}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Bookings List */}
      {!loading && !error && (
        <div className="fade-in">
          <h2 style={{ fontSize: '15px', fontWeight: '600', color: 'white', margin: '0 0 16px 0' }}>
            All Bookings
          </h2>

          {bookings.length === 0 ? (
            <div
              style={{
                backgroundColor: '#0d0d0d',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                borderRadius: '12px',
                padding: '48px 24px',
                textAlign: 'center',
              }}
            >
              <Calendar size={40} style={{ color: '#888', marginBottom: '16px' }} />
              <p style={{ fontSize: '13px', color: '#888', margin: '0' }}>
                No bookings found for the selected date range.
              </p>
            </div>
          ) : (
            <div
              style={{
                backgroundColor: '#0d0d0d',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                borderRadius: '12px',
                overflow: 'hidden',
              }}
            >
              {/* Headers */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 1.5fr 1.5fr 1fr 1.5fr 1fr',
                  gap: '16px',
                  padding: '16px 24px',
                  backgroundColor: '#0a0a0a',
                  borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                  fontSize: '12px',
                  color: '#888',
                  fontWeight: '600',
                }}
              >
                <div>Guest</div>
                <div>Contact</div>
                <div>Date & Time</div>
                <div>Service</div>
                <div>Status</div>
                <div>Source</div>
              </div>

              {/* Rows */}
              {bookings.map((booking, idx) => (
                <div
                  key={booking.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr 1.5fr 1.5fr 1fr 1.5fr 1fr',
                    gap: '16px',
                    padding: '16px 24px',
                    borderBottom:
                      idx < bookings.length - 1 ? '1px solid rgba(255, 255, 255, 0.06)' : 'none',
                    alignItems: 'center',
                    transition: 'background-color 0.2s ease',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.backgroundColor = 'rgba(201, 168, 76, 0.05)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  {/* Guest */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div
                      style={{
                        width: '32px',
                        height: '32px',
                        borderRadius: '50%',
                        backgroundColor: '#C9A84C',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#0a0a0a',
                        fontWeight: '600',
                        fontSize: '12px',
                        flexShrink: 0,
                      }}
                    >
                      {booking.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontSize: '13px', color: 'white', fontWeight: '500' }}>
                        {booking.name}
                      </div>
                    </div>
                  </div>

                  {/* Contact */}
                  <div>
                    <a
                      href={`tel:${booking.phone}`}
                      style={{
                        fontSize: '13px',
                        color: '#C9A84C',
                        textDecoration: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        marginBottom: '4px',
                      }}
                    >
                      <Phone size={14} />
                      {booking.phone}
                    </a>
                    <a
                      href={`mailto:${booking.email}`}
                      style={{
                        fontSize: '12px',
                        color: '#888',
                        textDecoration: 'none',
                      }}
                    >
                      {booking.email}
                    </a>
                  </div>

                  {/* Date & Time */}
                  <div>
                    <div style={{ fontSize: '13px', color: 'white', fontWeight: '500' }}>
                      {formatDate(booking.start_time)}
                    </div>
                    <div
                      style={{
                        fontSize: '12px',
                        color: '#888',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        marginTop: '4px',
                      }}
                    >
                      <Clock size={12} />
                      {formatTime(booking.start_time)} - {formatTime(booking.end_time)}
                    </div>
                  </div>

                  {/* Service */}
                  <div style={{ fontSize: '13px', color: '#888', textTransform: 'capitalize' }}>
                    {booking.service_type}
                  </div>

                  {/* Status */}
                  <div>{getStatusBadge(booking.status)}</div>

                  {/* Source */}
                  <div style={{ fontSize: '13px', color: '#888', textTransform: 'capitalize' }}>
                    {booking.source || 'web'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% {
            opacity: 0.6;
          }
          50% {
            opacity: 1;
          }
        }

        .fade-in {
          animation: fadeIn 0.3s ease;
        }

        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
};

const StatCard = ({ label, value, color = '#C9A84C' }) => {
  return (
    <div
      style={{
        backgroundColor: '#0d0d0d',
        border: '1px solid rgba(255, 255, 255, 0.06)',
        borderRadius: '12px',
        padding: '20px',
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = `rgba(201, 168, 76, 0.3)`;
        e.currentTarget.style.backgroundColor = 'rgba(201, 168, 76, 0.05)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.06)';
        e.currentTarget.style.backgroundColor = '#0d0d0d';
      }}
    >
      <div style={{ fontSize: '12px', color: '#888', fontWeight: '500', marginBottom: '12px' }}>
        {label}
      </div>
      <div style={{ fontSize: '32px', fontWeight: '600', color: color }}>
        {value}
      </div>
    </div>
  );
};

export default Bookings;
