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
      const url = `${protocol}//${host}/ws?api_key=${apiKey || ''}`;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        console.log('[ws] Connected');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setLastEvent(data);
        } catch (err) {
          console.warn('[ws] Parse error:', err);
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        // Auto-reconnect after 5s
        reconnectTimeoutRef.current = setTimeout(connect, 5000);
      };

      ws.onerror = (err) => {
        console.warn('[ws] Error');
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
