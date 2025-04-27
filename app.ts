import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'http';
import { Server } from 'socket.io';
import fs from 'fs'; // Added for file system access
import path from 'path'; // Added for path manipulation
import * as satellite from 'satellite.js'; // Added satellite.js
import axios from 'axios'; // Added axios for fetching POP data

// Dynamic configuration file
import config from './config';

// API Routes
import accountRouter from './routes/account';

// Types
import type GlobalObject from 'types/GlobalObject';
// Add satellite.js specific types we might need
import { SatRec, EciVec3, LookAngles } from 'satellite.js';

// --- Constants for File Paths ---
const DATA_DIR = path.join(__dirname, 'data'); // Original path based on __dirname
// const DATA_DIR = path.resolve(process.cwd(), 'data'); // Path relative to where the process is started (project root)
const LATEST_SATELLITE_FILE = path.join(DATA_DIR, 'latest_connected_satellite.txt');
const LATEST_POP_FILE = path.join(DATA_DIR, 'latest_pop.txt'); // Added POP file path
const OBSERVER_LOCATION_FILE = path.join(DATA_DIR, 'observer_location.json'); // Added observer file path
const TLE_BASE_DIR = path.join(DATA_DIR, 'TLE');
const POP_JSON_URL = "https://raw.githubusercontent.com/clarkzjw/starlink-geoip-data/refs/heads/master/map/pop.json"; // Added POP JSON URL
const MIN_ELEVATION_DEG = 0; // Minimum elevation angle (degrees) for a satellite to be considered "in view"
const VIEWPORT_EXPANSION_FACTOR = 1.5; // Factor to expand viewport for preloading nearby satellites
// -------------------------------

// --- Observer Location --- (Added Section)
interface ObserverLocation {
    latitude: number;
    longitude: number;
    altitude: number; // In km
}
// Simple interface to replace missing Geodetic type
interface ObserverCoords {
    latitude: number; // radians
    longitude: number; // radians
    height: number; // km
}
let observerLocation: ObserverLocation | null = null;
let observerCoordsGd: ObserverCoords | null = null; // Use custom interface

function loadObserverLocation() {
    console.log(`Attempting to load observer location from ${OBSERVER_LOCATION_FILE}`);
    try {
        if (fs.existsSync(OBSERVER_LOCATION_FILE)) {
            const data = fs.readFileSync(OBSERVER_LOCATION_FILE, 'utf-8');
            const loc = JSON.parse(data) as ObserverLocation;
            // Validate basic structure
            if (typeof loc.latitude === 'number' && typeof loc.longitude === 'number' && typeof loc.altitude === 'number') {
                 observerLocation = loc;
                 // Convert degrees to radians and store as Geodetic for calculations
                 observerCoordsGd = {
                    latitude: satellite.degreesToRadians(loc.latitude),
                    longitude: satellite.degreesToRadians(loc.longitude),
                    height: loc.altitude // Already in km
                 };
                 console.log("Observer location loaded:", observerLocation);
            } else {
                 console.error("Invalid format in observer_location.json");
            }
        } else {
             console.error(`Observer location file not found: ${OBSERVER_LOCATION_FILE}. Cannot filter satellites by elevation.`);
        }
    } catch (err) {
        console.error('Error reading or parsing observer location file:', err);
    }
}
// --- End Observer Location ---

// Added: Interface for LatLng (simple version)
interface LatLng {
    lat: number;
    lng: number;
}
// Added: Interface for Viewport Bounds
interface ViewportBounds {
    _southWest: LatLng;
    _northEast: LatLng;
}

// Added: Store client viewports (Map: socket.id -> ViewportBounds)
const clientViewports = new Map<string, ViewportBounds>();

// Express app setup
const app = express();
const httpServer = http.createServer(app);

// Initialize Socket.IO
const io = new Server(httpServer, {
  cors: {
    origin: config.allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

/**
 * Parsers
 */

app.use(express.json());
app.use(express.urlencoded());

/**
 * Load balancer health check
 */

// app.get('/ping', (req, res) => res.send('pong'));

const global: GlobalObject = {};

/**
 * Middlewares
 */

app.use((req, res, next) => {
  // CORS
  if (config.allowedOrigins.includes(req.headers.origin!)) res.setHeader('Access-Control-Allow-Origin', req.headers.origin!);

  // https://github.com/expressjs/session/issues/633
  app.set('trust proxy', true);

  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', req.get('Access-Control-Request-Headers')); // https://stackoverflow.com/questions/13146892/cors-access-control-allow-headers-wildcard-being-ignored amazing thing !!!!!
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('strict-transport-security', 'max-age=15552000; includeSubDomains');
  res.header('vary', 'Accept-Encoding');
  res.header('x-content-type-options', 'nosniff');

  res.header('x-download-options', 'noopen');

  res.header('x-frame-options', 'SAMEORIGIN');
  res.header('x-xss-protection', '1; mode=block');

  return next();
});

// app.use(cookieParser());

/**
 * Error Handler
 */

app.use((err: any, req: any, res: any, next: any) => {
  console.error(err);

  return res.send({
    success: false,
    message: `An internal error occurred.`,
  });
});

/**
 * API Routes
 */

app.use('/api/account', accountRouter(global));

/**
 * Starting the server
 */

const port = process.env.PORT || 3001;

// --- Helper Functions ---

// Function to find the latest TLE file
function findLatestTLEFile(): string | null {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const dateDir = path.join(TLE_BASE_DIR, today);

    if (!fs.existsSync(dateDir)) {
      console.warn(`TLE directory for today (${dateDir}) not found.`);
      // Optional: Add logic to check previous day(s)
      return null;
    }

    const files = fs.readdirSync(dateDir)
      .filter(file => file.startsWith('starlink-tle-') && file.endsWith('.txt'))
      .map(file => ({
        name: file,
        time: fs.statSync(path.join(dateDir, file)).mtime.getTime(),
      }))
      .sort((a, b) => b.time - a.time); // Sort descending by modification time

    if (files.length > 0) {
      return path.join(dateDir, files[0].name);
    }
  } catch (err) {
    console.error('Error finding latest TLE file:', err);
  }
  return null;
}

// Function to read the latest connected satellite name
function readLatestSatelliteName(): string | null {
  try {
    if (fs.existsSync(LATEST_SATELLITE_FILE)) {
      return fs.readFileSync(LATEST_SATELLITE_FILE, 'utf-8').trim();
    }
  } catch (err) {
    console.error('Error reading latest satellite file:', err);
  }
  return null;
}

// Function to read the latest POP code
function readLatestPOPCode(): string | null {
  try {
    if (fs.existsSync(LATEST_POP_FILE)) {
      return fs.readFileSync(LATEST_POP_FILE, 'utf-8').trim();
    }
  } catch (err) {
    console.error('Error reading latest POP file:', err);
  }
  return null;
}

// Function to parse TLE file content
function parseTLEData(filePath: string): Record<string, satellite.SatRec> {
  const satRecs: Record<string, satellite.SatRec> = {};
  try {
    const tleData = fs.readFileSync(filePath, 'utf-8');
    const lines = tleData.split(/\r?\n/);
    for (let i = 0; i < lines.length - 2; i += 3) {
      const line0 = lines[i].trim();
      const line1 = lines[i + 1]?.trim();
      const line2 = lines[i + 2]?.trim();

      // Basic validation
      if (line0 && line1 && line2 && line1.startsWith('1 ') && line2.startsWith('2 ')) {
          const satName = line0.startsWith('0 ') ? line0.substring(2) : line0;
          try {
            const satrec = satellite.twoline2satrec(line1, line2);
            satRecs[satName] = satrec;
          } catch (tleErr) {
            // console.warn(`Skipping invalid TLE entry for ${satName}: ${tleErr}`);
          }
      }
    }
  } catch (err) {
    console.error(`Error parsing TLE file ${filePath}:`, err);
  }
  return satRecs;
}

// Added: Function to fetch and cache POP locations
interface PopInfo {
    code: string;
    show: boolean;
    type: string;
    lat: string;
    lon: string;
    city: string;
    country: string;
}
let cachedPopLocations: Record<string, { lat: number; lon: number }> = {};
async function fetchAndCachePopLocations() {
    console.log("Fetching POP locations from URL...");
    try {
        const response = await axios.get<PopInfo[]>(POP_JSON_URL);
        const data = response.data;
        const newCache: Record<string, { lat: number; lon: number }> = {};
        for (const pop of data) {
            if (pop.show && pop.code && pop.type === "netfac" && pop.lat && pop.lon) {
                newCache[pop.code] = { lat: parseFloat(pop.lat), lon: parseFloat(pop.lon) };
            }
        }
        cachedPopLocations = newCache;
        console.log(`Cached ${Object.keys(cachedPopLocations).length} POP locations.`);
    } catch (error) {
        console.error("Error fetching or processing POP locations:", error);
        // Keep using old cache if fetch fails
    }
}

// --- End Helper Functions ---

// Cached TLE data
let cachedTLEs: Record<string, satellite.SatRec> = {};
let lastTLEFileChecked: string | null = null;

// Fetch POP data and Observer Location on startup
loadObserverLocation(); // Load observer location
fetchAndCachePopLocations();
// Optional: Refresh POP data periodically (e.g., every hour)
// setInterval(fetchAndCachePopLocations, 3600 * 1000); // 1 hour

// Added: Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);
  let timeoutId: NodeJS.Timeout | null = null; // Store timeout ID

  // Added: Listener for viewport updates from this client
  socket.on('viewportUpdate', (bounds: ViewportBounds) => {
    // Basic validation of received bounds
    if (bounds && bounds._northEast && bounds._southWest &&
        typeof bounds._northEast.lat === 'number' && typeof bounds._northEast.lng === 'number' &&
        typeof bounds._southWest.lat === 'number' && typeof bounds._southWest.lng === 'number')
    {
        // console.log(`Received viewportUpdate from ${socket.id}:`, bounds); // DEBUG
        clientViewports.set(socket.id, bounds);
        console.log(` -> Received viewportUpdate from ${socket.id}:`, bounds);

        // --- Trigger immediate update on viewport change ---
        if (timeoutId) {
            clearTimeout(timeoutId); // Cancel the scheduled update
            console.log(` -> Cleared scheduled update for ${socket.id} due to viewport change.`);
        }
        // Schedule an immediate update (delay 0 or minimal)
        // Using a small delay (e.g., 10ms) can sometimes prevent race conditions
        // if the event triggers very rapidly, but 0 should usually be fine.
        timeoutId = setTimeout(() => scheduleUpdate(socket), 0); // Trigger now
        console.log(` -> Immediately triggered update for ${socket.id} due to viewport change.`);
        // ----------------------------------------------------

    } else {
        console.warn(`Received invalid viewportUpdate from ${socket.id}:`, bounds);
    }
  });

  // Function to perform and schedule the next satellite update
  const scheduleUpdate = (currentSocket: typeof socket) => {
    const currentSatelliteName = readLatestSatelliteName();

    console.log(` -> currentSatelliteName: ${currentSatelliteName}`); // DEBUG

    const currentPopCode = readLatestPOPCode();
    let currentPopData: { id: string; latitude: number; longitude: number; } | null = null;
    if (currentPopCode && cachedPopLocations[currentPopCode]) {
        const popCoords = cachedPopLocations[currentPopCode];
        currentPopData = { id: currentPopCode, latitude: popCoords.lat, longitude: popCoords.lon };
    }

    // Get the viewport for this specific client
    const currentViewport = clientViewports.get(currentSocket.id);

    // Initialize data arrays/objects for this cycle
    let connectedSatelliteData: any = null;
    const otherSatellitesData: any[] = [];

    // Check TLE data
    const latestTLEFile = findLatestTLEFile();

    console.log(` -> latestTLEFile: ${latestTLEFile}`); // DEBUG

    if (latestTLEFile) {
        if (latestTLEFile !== lastTLEFileChecked) {
            console.log(` -> Loading TLE data from: ${latestTLEFile}`);
            cachedTLEs = parseTLEData(latestTLEFile);
            lastTLEFileChecked = latestTLEFile;
            if (Object.keys(cachedTLEs).length === 0) { console.warn(' -> Skipping: Failed to parse any valid TLE records.'); }
        }

        if (Object.keys(cachedTLEs).length > 0) {
            const now = new Date();
            const gmst = satellite.gstime(now);

            console.time('satellite_propagation');

            // Iterate through all loaded TLEs
            for (const satName in cachedTLEs) {
                const currentSatrec = cachedTLEs[satName];
                if (!currentSatrec) continue;

                try {
                    const positionAndVelocity = satellite.propagate(currentSatrec, now);
                    if (!positionAndVelocity || typeof positionAndVelocity.position === 'boolean') continue;

                    const positionEci = positionAndVelocity.position as EciVec3<number>;
                    if (!positionEci) continue;

                    const positionGd = satellite.eciToGeodetic(positionEci, gmst);
                    const latitude = satellite.degreesLat(positionGd.latitude);
                    const longitude = satellite.degreesLong(positionGd.longitude);

                    let includeSatellite = false;
                    if (satName === currentSatelliteName) {
                        includeSatellite = true;
                    } else if (currentViewport) {
                        // Calculate viewport center and span
                        const centerLat = (currentViewport._northEast.lat + currentViewport._southWest.lat) / 2;
                        let lngSpan = currentViewport._northEast.lng - currentViewport._southWest.lng;
                        if (lngSpan < 0) { // Viewport crosses the antimeridian
                            lngSpan += 360;
                        }
                        let centerLng = currentViewport._southWest.lng + lngSpan / 2;
                        // Normalize centerLng to [-180, 180]
                        if (centerLng > 180) centerLng -= 360;

                        const latSpan = currentViewport._northEast.lat - currentViewport._southWest.lat;

                        // Calculate expanded bounds radius
                        const expandedLatRadius = (latSpan / 2) * VIEWPORT_EXPANSION_FACTOR;
                        const expandedLngRadius = (lngSpan / 2) * VIEWPORT_EXPANSION_FACTOR;

                        // Check latitude (clamped)
                        const expandedMinLat = Math.max(-90, centerLat - expandedLatRadius);
                        const expandedMaxLat = Math.min(90, centerLat + expandedLatRadius);
                        const isInLatBounds = latitude >= expandedMinLat && latitude <= expandedMaxLat;

                        // Check longitude (handling wrap-around)
                        let deltaLng = longitude - centerLng;
                        if (deltaLng > 180) deltaLng -= 360;
                        else if (deltaLng <= -180) deltaLng += 360;
                        const isInLngBounds = Math.abs(deltaLng) <= expandedLngRadius;

                        if (isInLatBounds && isInLngBounds) {
                            includeSatellite = true;
                        }
                    } else if (observerCoordsGd) {
                        try {
                            const positionEcf = satellite.eciToEcf(positionEci, gmst);
                            const lookAngles : LookAngles = satellite.ecfToLookAngles(observerCoordsGd, positionEcf);
                            if (satellite.degreesLat(lookAngles.elevation) > MIN_ELEVATION_DEG) {
                                includeSatellite = true;
                            }
                        } catch (lookAngleError) { /* Ignore error for filtering */ }
                    } // else: default to not including if no viewport/observer filter passes

                    if (includeSatellite) {
                        const satData = { id: satName, latitude: latitude, longitude: longitude };
                        if (satName === currentSatelliteName) {
                            connectedSatelliteData = { ...satData, timestamp: now.toISOString() };
                        } else {
                            otherSatellitesData.push(satData);
                        }
                    }
                } catch (propagateError) {
                    console.error(` -> Error propagating satellite ${satName}:`, propagateError);
                }
            }
            
            console.timeEnd('satellite_propagation');
        }
    }

    // --- Calculate total satellites processed/filtered in this cycle ---
    const totalSatellites = otherSatellitesData.length + (connectedSatelliteData ? 1 : 0);

    console.log(` -> totalSatellites: ${totalSatellites}`); // DEBUG

    // --- Determine next delay based on the count ---
    let nextDelay: number;

    if(totalSatellites < 100) {
      nextDelay = 50;
    } else if (totalSatellites < 300) {
      nextDelay = 100;
    } else if (totalSatellites < 600) {
      nextDelay = 200;
    } else if (totalSatellites < 1000) {
      nextDelay = 500;
    } else {
      nextDelay = 1000;
    }
    // console.log(`[${currentSocket.id}] Total Sats: ${totalSatellites}, Next Delay: ${nextDelay}ms`); // DEBUG

    // Emit the combined data structure (only if there's something to send)
    if (connectedSatelliteData || otherSatellitesData.length > 0 || currentPopData) {
        const allData = {
            connectedSatellite: connectedSatelliteData,
            otherSatellites: otherSatellitesData,
            currentPop: currentPopData,
            observerLocation: observerLocation,
            timestamp: new Date().toISOString() // Use a fresh timestamp for emission
        };
       // console.log(` -> Emitting: Connected: ${connectedSatelliteData?.id}, Others: ${otherSatellitesData.length}, POP: ${currentPopData?.id}`);
        currentSocket.emit('satelliteUpdate', allData);
    }

    // --- Schedule the next update ---
    // Ensure we only schedule if the socket is still connected
    if (currentSocket.connected) {
        timeoutId = setTimeout(() => scheduleUpdate(currentSocket), nextDelay);
    } else {
        // If socket disconnected while processing, clear the timeout variable just in case
        timeoutId = null;
        console.log(`Socket ${currentSocket.id} disconnected during update processing. Not rescheduling.`);
    }
  };

  // Start the first update cycle (e.g., with the minimum delay)
  timeoutId = setTimeout(() => scheduleUpdate(socket), 200);

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
    clientViewports.delete(socket.id); // Remove viewport on disconnect
    if (timeoutId) {
        clearTimeout(timeoutId); // Stop the update loop for this socket
        console.log(`Cleared update timeout for ${socket.id}`);
    }
  });
});

// Starting the server using httpServer
httpServer.listen(port, () => {
  console.log(`Backend started on port ${port} with env ${process.env.NODE_ENV}. Socket.IO listening.`);
});

/**
 * Process kill SIGTERM
 */
process.on('SIGTERM', () => {
  console.info('Got SIGTERM. Graceful shutdown start', new Date().toISOString());

  // Allow the server to finish any ongoing requests, but tell it to stop
  httpServer.close(() => {
    console.info('HTTP server closed.');
    io.close(() => {
      console.info('Socket.IO server closed.');
    process.exit(0);
    });
  });

  // Forcefully shut down if not closed within a certain time
  setTimeout(() => {
    console.error('Forcing shutdown due to timeout.');
    process.exit(1);
  }, 10_000);
});

