import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Map, { Marker, Popup, Source, Layer, NavigationControl, ViewStateChangeEvent, MapRef } from 'react-map-gl/maplibre';
// Import other components and types from the main react-map-gl package
// import { Socket, io } from 'socket.io-client'; // Removed Socket, io import
import { useSocket } from '@contexts/SocketContext'; // Import useSocket hook
import debounce from 'lodash.debounce'; // Import debounce
// Import MapLibre CSS 
import 'maplibre-gl/dist/maplibre-gl.css';

// Import GeoJSON types (optional but good practice)
import type { FeatureCollection, Point } from 'geojson';

// Define single satellite data type
interface SingleSatelliteData {
  id: string;
  latitude: number;
  longitude: number;
  timestamp?: string; // Only present for connected
  
}

// Define POP data structure
interface PopData {
    id: string;
    latitude: number;
    longitude: number;
}

// Define observer location type again for props
interface ObserverLocationData {
    latitude: number;
    longitude: number;
    altitude: number; // In km
}

// Update props to accept socket, observer location
interface MapComponentProps {
  // No socket prop needed anymore
  connectedSatellite: SingleSatelliteData | null;
  otherSatellites: SingleSatelliteData[];
  currentPop: PopData | null;
  observerLocation: ObserverLocationData | null; // Add observer location prop
}

// Add settings interface
interface MapSettings {
  followSatellite: boolean;
}

// --- Component --- 
const MapComponent: React.FC<MapComponentProps> = ({ connectedSatellite, otherSatellites, currentPop, observerLocation }) => {
  // Get socket from context
  const { socket } = useSocket();
  const mapRef = useRef<MapRef>(null); // Create map ref

  // Add settings state
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<MapSettings>({
    followSatellite: true
  });

  // Map viewport state
  const [viewState, setViewState] = useState({
    longitude: currentPop?.longitude ?? connectedSatellite?.longitude ?? -96.94, // Initial center
    latitude: currentPop?.latitude ?? connectedSatellite?.latitude ?? 29.44,
    zoom: 6, // Initial zoom (adjust as needed)
    pitch: 0, // Optional: angle map (0-60)
    bearing: 0 // Optional: rotate map
  });

  // Update center when connected satellite changes (optional, could be jumpy)
  useEffect(() => {
     if (connectedSatellite && settings.followSatellite) {
        setViewState(v => ({
          ...v,
          longitude: connectedSatellite.longitude,
          latitude: connectedSatellite.latitude,
        }));
     }
  }, [connectedSatellite?.id, connectedSatellite?.latitude, connectedSatellite?.longitude, settings.followSatellite]);

  // --- Debounced Viewport Emitter ---
  const debouncedEmitViewport = useCallback(
    debounce(() => {
       if (socket && socket.connected && mapRef.current) {
          try {
              const mapInstance = mapRef.current.getMap();
              const bounds = mapInstance.getBounds(); // Get bounds
              if (bounds) { // Add null check for bounds
                 const boundsData = {
                    _southWest: bounds.getSouthWest(),
                    _northEast: bounds.getNorthEast(),
                 };
                 // console.log("Emitting accurate viewportUpdate:", boundsData);
                 socket.emit('viewportUpdate', boundsData);
              } else {
                 console.warn("Could not get map bounds from map instance.");
              }
          } catch (e) {
              console.error("Error getting map bounds:", e);
          }
       }
     }, 125),
     [socket] 
  );

  // Update viewport state on move (emission is now separate)
  const handleMove = (evt: ViewStateChangeEvent) => {
      if (settings.followSatellite) {
        // When following satellite, only update zoom
        setViewState(prev => ({
          ...prev,
          zoom: evt.viewState.zoom,
          pitch: evt.viewState.pitch,
          bearing: evt.viewState.bearing
        }));
      } else {
        // When not following, update everything
        setViewState(evt.viewState);
      }
      // Always emit viewport updates
      debouncedEmitViewport();
  };

  // --- Initial Viewport Emit --- 
  // Need to emit bounds once the map is loaded
  const handleLoad = useCallback(() => {
      console.log("Map loaded, emitting initial viewport.");
      // Use a slight delay to ensure bounds are ready after load
      setTimeout(() => debouncedEmitViewport(), 100);
  }, [debouncedEmitViewport]);

  // Cleanup debounce on unmount
  useEffect(() => {
     return () => {
       debouncedEmitViewport.cancel();
     };
  }, [debouncedEmitViewport]);
  // --- End Viewport Emitter ---

  // --- Render Markers & GeoJSON Source --- 
  // Memoize markers to prevent unnecessary re-renders if data hasn't changed
  const connectedSatMarker = useMemo(() => {
    if (!connectedSatellite) return null;
    return (
      <Marker 
        key={connectedSatellite.id} 
        longitude={connectedSatellite.longitude} 
        latitude={connectedSatellite.latitude} 
        anchor="bottom"
      >
         {/* Basic marker style, can be customized with CSS or image */}
         <div style={{ color: 'white', background: 'blue', borderRadius: '50%', padding: '5px', fontSize: '10px' }}>SAT</div> 
         {/* Add Popup if needed */}
      </Marker>
    );
  }, [connectedSatellite]);

  const popMarker = useMemo(() => {
     if (!currentPop) return null;
     return (
       <Marker 
         key={currentPop.id} 
         longitude={currentPop.longitude} 
         latitude={currentPop.latitude} 
         anchor="bottom"
         color="green" // Use built-in color prop for simplicity
       >
         {/* Basic marker style */}
         <div style={{ color: 'white', background: 'green', borderRadius: '50%', padding: '5px', fontSize: '10px' }}>POP</div>
         {/* Add Popup if needed */}
       </Marker>
     );
   }, [currentPop]);

  // Create GeoJSON source data for other satellites
  const otherSatellitesGeoJSON: FeatureCollection<Point> = useMemo(() => {
    return {
      type: 'FeatureCollection',
      features: otherSatellites.map(sat => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [sat.longitude, sat.latitude]
        },
        properties: { // Optional: Add properties if you need them for popups/styling later
          id: sat.id
        }
      }))
    };
  }, [otherSatellites]);

  // Memoized observer marker
  const observerMarker = useMemo(() => {
     if (!observerLocation) return null;
     return (
        <Marker 
           key="observer-location"
           longitude={observerLocation.longitude} 
           latitude={observerLocation.latitude} 
           anchor="center"
           color="red" // Use a distinct color
         >
           {/* Simple marker style */}
           <div style={{ width: '10px', height: '10px', background: 'red', borderRadius: '50%', border: '1px solid white' }} title="Your Location"></div>
           {/* Add Popup if needed */}
         </Marker>
     );
  }, [observerLocation]);

  // Render null or a placeholder if socket is not yet available from context
  if (!socket) {
      return <div>Connecting map socket...</div>; // Or return null, or a loading spinner
  }

  return (
    <Map
       ref={mapRef} // Assign ref to the Map component
       {...viewState}
       onMove={handleMove}
       onLoad={handleLoad} // Call handler on map load
       style={{ width: '100%', height: '100%' }}
       mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" // Use CartoCDN Dark Matter (keyless)
       dragRotate={false} // Prevent rotation via right-click drag
       projection="globe" // Enable 3D globe view (requires maplibre-gl v3+)
    >
      {/* --- GeoJSON Source and Layer for Other Satellites --- */}
      <Source id="other-satellites" type="geojson" data={otherSatellitesGeoJSON}>
        <Layer
          id="other-satellites-layer"
          type="circle" // Use circle layer for simple dots
          source="other-satellites"
          paint={{
            'circle-radius': 3, // Adjust size as needed
            'circle-color': 'orange', // Adjust color as needed
            'circle-opacity': 0.8
          }}
        />
        {/* Add another layer here for labels if needed, using type: 'symbol' */}
      </Source>

      {/* Map Controls */} 
      <NavigationControl position="top-left" />

      {/* Settings Button */}
      <div 
        style={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          cursor: 'pointer',
          color: 'white',
          fontSize: '24px',
          zIndex: 1
        }}
        onClick={() => setShowSettings(!showSettings)}
      >
        ⚙️
      </div>

      {/* Settings Popup */}
      {showSettings && (
        <div
          style={{
            position: 'absolute',
            top: '50px',
            right: '10px',
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            padding: '15px',
            borderRadius: '8px',
            color: 'white',
            zIndex: 2
          }}
        >
          <div style={{ marginBottom: '10px', fontWeight: 'bold' }}>Settings</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings.followSatellite}
              onChange={(e) => setSettings(prev => ({ ...prev, followSatellite: e.target.checked }))}
            />
            Follow current satellite
          </label>
        </div>
      )}

      {/* Render Markers (Keep these for specific items) */} 
      {connectedSatMarker}
      {popMarker}
      {observerMarker}
    </Map>
  );
};

export default MapComponent; 