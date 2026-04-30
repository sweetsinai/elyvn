import { useState, useEffect, useRef, useCallback } from 'react';

export function useWebSocket(apiKey) {
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 10;

  const connect = useCallback(() => {
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      const url = `${protocol}//${host}/ws`;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {};

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'auth_required') {
            const token = sessionStorage.getItem('elyvn_token') || '';
            const fallbackKey = apiKey || sessionStorage.getItem('elyvn_api_key') || '';
            if (token) {
              ws.send(JSON.stringify({ type: 'auth', token: token }));
            } else {
              ws.send(JSON.stringify({ type: 'auth', api_key: fallbackKey }));
            }
            return;
          }

          if (data.type === 'authenticated') {
            setIsConnected(true);
            reconnectAttempts.current = 0;
            return;
          }

          setLastEvent(data);
        } catch (err) {
          console.warn('[ws] Parse error:', err);
        }
      };

      ws.onclose = (e) => {
        setIsConnected(false);
        if (e.code === 4003) {
          console.warn('[ws] Auth rejected — not reconnecting');
          return;
        }
        if (reconnectAttempts.current < maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
          reconnectAttempts.current += 1;
          reconnectTimeoutRef.current = setTimeout(connect, delay);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch (err) {
      console.warn('[ws] Connection failed:', err);
    }
  }, [apiKey]);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, [connect]);

  return { isConnected, lastEvent };
}
