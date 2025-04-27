# flake8: noqa: E501
import time
import logging
import argparse
import schedule
import sys
import os
from pathlib import Path
import json

import config
from latency import icmp_ping
from dish import (
    grpc_get_status,
    get_obstruction_map,
)
from pop import get_home_pop
from util import run, load_tle, date_time_string
from config import print_config, LATITUDE, LONGITUDE, ALTITUDE


logger = logging.getLogger(__name__)

# --- Path for latest POP output ---
# Assumes DATA_DIR is set relative to starlink/ execution directory (e.g., ../data)
DATA_DIR_PATH = Path(os.environ.get("DATA_DIR", "../data")).resolve()
LATEST_POP_FILE = DATA_DIR_PATH / 'latest_pop.txt'
OBSERVER_LOCATION_FILE = DATA_DIR_PATH / 'observer_location.json'
# -------------------------------

schedule.every(1).hours.at(":00").do(run, icmp_ping).tag("Latency")
schedule.every(1).hours.at(":00").do(run, grpc_get_status).tag("gRPC_Status")
schedule.every(1).hours.at(":00").do(run, load_tle).tag("TLE")


def run_continuously():
    """Runs the obstruction map collection and satellite/POP estimation continuously."""
    logger.info("Starting continuous collection...")
    last_pop_check_time = 0
    pop_check_interval = 60 # Check POP every 60 seconds

    while True:
        try:
            current_time = time.time()

            # --- Check and update POP periodically ---
            if current_time - last_pop_check_time > pop_check_interval:
                logger.info("Checking current POP...")
                try:
                    current_pop = get_home_pop()
                    if current_pop:
                        logger.info(f"Current POP detected: {current_pop}")
                        try:
                            # Ensure the data directory exists
                            LATEST_POP_FILE.parent.mkdir(parents=True, exist_ok=True)
                            with open(LATEST_POP_FILE, 'w') as f:
                                f.write(current_pop)
                            logger.info(f"Updated POP file: {LATEST_POP_FILE}")
                        except Exception as e:
                            logger.error(f"Failed to write POP file {LATEST_POP_FILE}: {e}")
                    else:
                        logger.warning("Could not determine current POP.")
                    last_pop_check_time = current_time # Update last check time regardless of success
                except Exception as e:
                     logger.error(f"Error during get_home_pop: {e}")
                     last_pop_check_time = current_time # Still update time to avoid spamming errors
            # --- End POP Check ---

            # --- Run Obstruction Map / Satellite Estimation ---
            logger.info("Starting Obstruction Map collection cycle...")
            get_obstruction_map() # This function now handles its own timing/loops internally
            logger.info("Finished Obstruction Map collection cycle.")
            # --- End Obstruction Map Cycle ---

        except KeyboardInterrupt:
            logger.info("KeyboardInterrupt received, stopping continuous run.")
            sys.exit(0)
        except Exception as e:
            logger.error(f"Error in main continuous loop: {e}. Restarting loop after delay...")
            time.sleep(10) # Wait before retrying after an error


def write_observer_location(lat, lon, alt):
    location_data = {
        "latitude": lat,
        "longitude": lon,
        "altitude": alt / 1000.0 # satellite.js expects altitude in km
    }
    try:
        OBSERVER_LOCATION_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(OBSERVER_LOCATION_FILE, 'w') as f:
            json.dump(location_data, f, indent=2)
        logger.info(f"Observer location written to {OBSERVER_LOCATION_FILE}")
    except Exception as e:
        logger.error(f"Failed to write observer location file {OBSERVER_LOCATION_FILE}: {e}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LEOViz | Starlink metrics collection")

    parser.add_argument("--run-once", action="store_true", help="Run once and exit (only scheduled tasks)")
    parser.add_argument("--lat", type=float, required=False, help="Dish latitude")
    parser.add_argument("--lon", type=float, required=False, help="Dish longitude")
    parser.add_argument("--alt", type=float, required=False, help="Dish altitude (in meters)")
    args = parser.parse_args()

    print_config()

    # Configure lat/lon/alt (important to do this before writing file)
    if args.lat and args.lon and args.alt:
        config.LATITUDE = args.lat
        config.LONGITUDE = args.lon
        config.ALTITUDE = args.alt
    elif not args.run_once:
        # Use config values if args not provided but needed for continuous
        if config.LATITUDE is not None and config.LONGITUDE is not None and config.ALTITUDE is not None:
            logger.warning("Using LATITUDE/LONGITUDE/ALTITUDE from config/environment.")
        else:
            logger.error("Latitude, Longitude, and Altitude are required for continuous satellite tracking (use --lat/--lon/--alt or set in config). Exiting.")
            sys.exit(1)

    # Write observer location if we have it
    if config.LATITUDE is not None and config.LONGITUDE is not None and config.ALTITUDE is not None:
        write_observer_location(config.LATITUDE, config.LONGITUDE, config.ALTITUDE)
    else:
        # If running once, location isn't strictly needed by this script
        if not args.run_once:
             logger.error("Observer location could not be determined. Exiting continuous mode.")
             sys.exit(1)

    if args.run_once:
        logger.info("Running scheduled tasks once and exiting.")
        schedule.run_all()
    else:
        load_tle()
        run_continuously()
