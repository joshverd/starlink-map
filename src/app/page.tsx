'use client'; // Make it a client component

import React, { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useSocket } from '@contexts/SocketContext'; // Import useSocket hook
// import 'leaflet/dist/leaflet.css'; // Removed Leaflet CSS
// import 'mapbox-gl/dist/mapbox-gl.css'; // Added Mapbox CSS
import 'maplibre-gl/dist/maplibre-gl.css'; // Use MapLibre CSS instead

import style from './page.module.scss';

// Define satellite data type
interface SingleSatelliteData {
  id: string;
  latitude: number;
  longitude: number;
  timestamp?: string; // Optional for others
}

// Define observer location data type (must match what's in observer_location.json)
interface ObserverLocationData {
    latitude: number;
    longitude: number;
    altitude: number; // In km
}

// Define the structure received from the socket
interface AllSatelliteData {
  connectedSatellite: SingleSatelliteData | null;
  otherSatellites: SingleSatelliteData[];
  currentPop: { // Added POP data structure
    id: string;
    latitude: number;
    longitude: number;
  } | null;
  observerLocation: ObserverLocationData | null; // Added observer location field
  timestamp: string; // Overall timestamp
}

// Dynamically import the Map component to avoid SSR issues with Leaflet
const MapComponent = dynamic(
  () => import('./_components/MapComponent'), // Assume we create MapComponent.tsx in src/components
  { ssr: false }
);

const Home = () => {
  const [allSatData, setAllSatData] = useState<AllSatelliteData | null>(null);
  const { socket } = useSocket(); // Get socket from context

  useEffect(() => {
    // Listen for updates if the socket from context is connected
    if (socket) {
      console.log("Home: Socket context connected, setting up listener.");
      const handleUpdate = (data: AllSatelliteData) => {
        setAllSatData(data);
      };

      socket.on('satelliteUpdate', handleUpdate);

      // Cleanup listener on component unmount or socket change
      return () => {
        console.log("Home: Removing satelliteUpdate listener.");
        socket.off('satelliteUpdate', handleUpdate);
      };
    } else {
       console.log("Home: Socket context not yet available.");
    }
    // Removed manual connection/disconnection logic
  }, [socket]); // Re-run effect if socket instance changes

  return (
    <main className={style.main}>
      <div className={style.mapContainer} style={{ height: '100dvh', width: '100dvw' }}>
        <MapComponent
          connectedSatellite={allSatData?.connectedSatellite ?? null}
          otherSatellites={allSatData?.otherSatellites ?? []}
          currentPop={allSatData?.currentPop ?? null}
          observerLocation={allSatData?.observerLocation ?? null}
        />
      </div>
    </main>
  );
};

export default Home;
