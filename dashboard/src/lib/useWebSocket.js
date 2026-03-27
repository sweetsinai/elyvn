import { useState, useEffect, useRef, useCallback } from 'react';

export function useWebSocket(apiKey) {
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  const connect = useCallback(() => {
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      // No API key in URL — auth via first message
      const url = `${protocol}//${host}/ws`;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[ws] Connected, authenticating...');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // Server asks for auth — send API key via message (not URL)
          if (data.type === 'auth_required') {
            ws.send(JSON.stringify({ type: 'auth', api_key: apiKey || '' }));
            return;
          }

          // Auth confirmed
          if (data.type === 'authenticated') {
            setIsConnected(true);
            console.log('[ws] Authenticated');
            return;
          }

          // Regular event
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
        // Auto-reconnect after 5s
        reconnectTimeoutRef.current = setTimeout(connect, 5000);
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
