'use client';

import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { io, Socket } from 'socket.io-client';
import { DefaultEventsMap } from '@socket.io/component-emitter'; // Import this type

// Define the shape of the context value
interface SocketContextType {
  socket: Socket<DefaultEventsMap, DefaultEventsMap> | null;
}

// Create the context with a default value
const SocketContext = createContext<SocketContextType>({ socket: null });

// Custom hook to use the SocketContext
export const useSocket = (): SocketContextType => {
  return useContext(SocketContext);
};

// Define the props for the provider
interface SocketProviderProps {
  children: ReactNode;
}

// Create the provider component
export const SocketProvider: React.FC<SocketProviderProps> = ({ children }) => {
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    // Establish connection only on the client side
    if (typeof window !== 'undefined') {
      console.log("SocketProvider: Initializing socket connection...");

      const host = window.location.host;

      // Remove port number from host if present
      const hostWithoutPort = host.replace(/:\d+$/, '');

      const URL = `http://${hostWithoutPort}:3001`;

      // Connect to the backend server (ensure URL is correct)
      const socketInstance = io(URL, {
        transports: ['websocket'],
        secure: true,
        withCredentials: true,
      });

      console.log("SocketProvider: Connecting to socket at:", URL);

      socketInstance.on('connect', () => {
        console.log('SocketProvider: Socket connected:', socketInstance.id);
        setSocket(socketInstance); 
      });

      socketInstance.on('disconnect', (reason) => {
        console.log('SocketProvider: Socket disconnected:', reason);
        setSocket(null);
        // Optional: attempt reconnection logic here if needed
      });

      socketInstance.on('connect_error', (err) => {
        console.error('SocketProvider: Socket connection error:', err);
        setSocket(null); // Ensure socket state is null on error
      });

      // Cleanup on component unmount
      return () => {
        if (socketInstance) {
          console.log("SocketProvider: Disconnecting socket on cleanup.");
          socketInstance.disconnect();
          setSocket(null);
        }
      };
    }
  }, []); // Empty dependency array ensures this runs only once

  return (
    <SocketContext.Provider value={{ socket }}>
      {children}
    </SocketContext.Provider>
  );
}; 