# flake8: noqa: E501

import os
import csv
import sys
import json
import time
import logging
import subprocess
import threading
import glob

import config

from satellites import convert_observed, process_intervals

from datetime import datetime, timezone, timedelta
from pathlib import Path
from config import DATA_DIR, STARLINK_GRPC_ADDR_PORT, DURATION_SECONDS, TLE_DATA_DIR
from util import date_time_string, ensure_data_directory
from obstruction import process_obstruction_timeslot

import numpy as np
import pandas as pd
from skyfield.api import load

logger = logging.getLogger(__name__)

# --- Path for latest satellite output ---
LATEST_SATELLITE_FILE = os.path.join(DATA_DIR, 'latest_connected_satellite.txt')
# ----------------------------------------

sys.path.insert(0, str(Path("./starlink-grpc-tools").resolve()))
import starlink_grpc

GRPC_DATA_DIR = "{}/grpc".format(DATA_DIR)
GRPC_TIMEOUT = 10

# --- New function to get orientation ---
def get_current_dish_orientation():
    cmd = [
        "grpcurl", "-plaintext", "-d", '{"get_status":{}}',
        STARLINK_GRPC_ADDR_PORT, "SpaceX.API.Device.Device/Handle"
    ]
    try:
        output = subprocess.check_output(cmd, timeout=GRPC_TIMEOUT)
        data = json.loads(output.decode('utf-8'))
        if data.get("dishGetStatus") and data["dishGetStatus"].get("alignmentStats"):
            alignment = data["dishGetStatus"]["alignmentStats"]
            tilt = alignment.get("tiltAngleDeg", 0)
            azimuth = alignment.get("boresightAzimuthDeg", 0)
            logger.info(f"Fetched dish orientation: Tilt={tilt}, Azimuth={azimuth}")
            return {'tilt': tilt, 'azimuth': azimuth}
        else:
            logger.warning("Could not extract alignmentStats from GetStatus response.")
            return None
    except subprocess.TimeoutExpired:
        logger.error("Timeout getting dish orientation.")
        return None
    except Exception as e:
        logger.error(f"Error getting dish orientation: {e}")
        return None
# --- End new function ---

def grpc_get_status() -> None:
    name = "GRPC_GetStatus"
    logger.info("{}, {}".format(name, threading.current_thread()))

    FILENAME = "{}/{}/GetStatus-{}.txt".format(
        GRPC_DATA_DIR, ensure_data_directory(GRPC_DATA_DIR), date_time_string()
    )

    # grpcurl -plaintext -d {\"get_status\":{}} 192.168.100.1:9200 SpaceX.API.Device.Device/Handle
    cmd = [
        "grpcurl",
        "-plaintext",
        "-d",
        '{"get_status":{}}',
        STARLINK_GRPC_ADDR_PORT,
        "SpaceX.API.Device.Device/Handle",
    ]
    try:
        with open(FILENAME, "w") as outfile:
            subprocess.run(cmd, stdout=outfile, timeout=GRPC_TIMEOUT)
    except subprocess.TimeoutExpired:
        pass

    logger.info("Saved gRPC dish status to {}".format(FILENAME))


def get_sinr(dt_string):
    name = "GRPC_phyRxBeamSnrAvg"
    logger.info("{}, {}".format(name, threading.current_thread()))

    FILENAME = "{}/{}/GRPC_STATUS-{}.csv".format(
        GRPC_DATA_DIR, ensure_data_directory(GRPC_DATA_DIR), dt_string
    )

    cmd = [
        "grpcurl",
        "-plaintext",
        "-d",
        '{"get_status":{}}',
        STARLINK_GRPC_ADDR_PORT,
        "SpaceX.API.Device.Device/Handle",
    ]
    with open(FILENAME, "w") as outfile:
        start = time.time()
        csv_writer = csv.writer(outfile)
        csv_writer.writerow(
            [
                "timestamp",
                "sinr",
                "popPingLatencyMs",
                "downlinkThroughputBps",
                "uplinkThroughputBps",
                "tiltAngleDeg",
                "boresightAzimuthDeg",
                "boresightElevationDeg",
                "attitudeEstimationState",
                "attitudeUncertaintyDeg",
                "desiredBoresightAzimuthDeg",
                "desiredBoresightElevationDeg",
            ]
        )
        while time.time() < start + DURATION_SECONDS:
            try:
                output = subprocess.check_output(cmd, timeout=GRPC_TIMEOUT)
                data = json.loads(output.decode("utf-8"))
                if (
                    data["dishGetStatus"] is not None
                    # Starlink may have just rollbacked the firmware
                    # from 2025.04.08.cr53207 to 2025.03.28.mr52463.2
                    # thus removing phyRxBeamSnrAvg again
                    # and "phyRxBeamSnrAvg" in data["dishGetStatus"]
                    and "alignmentStats" in data["dishGetStatus"]
                ):
                    status = data["dishGetStatus"]
                    sinr = status.get("phyRxBeamSnrAvg", 0)
                    alignment = status["alignmentStats"]
                    popPingLatencyMs = status.get("popPingLatencyMs", 0)
                    dlThroughputBps = status.get("downlinkThroughputBps", 0)
                    upThroughputBps = status.get("uplinkThroughputBps", 0)
                    csv_writer.writerow(
                        [
                            time.time(),
                            sinr,
                            popPingLatencyMs,
                            dlThroughputBps,
                            upThroughputBps,
                            alignment.get("tiltAngleDeg", 0),
                            alignment.get("boresightAzimuthDeg", 0),
                            alignment.get("boresightElevationDeg", 0),
                            alignment.get("attitudeEstimationState", ""),
                            alignment.get("attitudeUncertaintyDeg", 0),
                            alignment.get("desiredBoresightAzimuthDeg", 0),
                            alignment.get("desiredBoresightElevationDeg", 0),
                        ]
                    )
                    outfile.flush()
                    time.sleep(0.5)
            except Exception:
                pass

    logger.info("SNR measurement saved to {}".format(FILENAME))


def wait_until_target_time(last_timeslot_second):
    while True:
        current_second = datetime.now(timezone.utc).second
        if current_second >= 12 and current_second < 27 and last_timeslot_second != 12:
            last_timeslot_second = 12
            break
        elif (
            current_second >= 27 and current_second < 42 and last_timeslot_second != 27
        ):
            last_timeslot_second = 27
            break
        elif (
            current_second >= 42 and current_second < 57 and last_timeslot_second != 42
        ):
            last_timeslot_second = 42
            break
        elif (
            current_second >= 57 and current_second < 60 and last_timeslot_second != 57
        ):
            last_timeslot_second = 57
            break
        elif current_second >= 0 and current_second < 12 and last_timeslot_second != 57:
            last_timeslot_second = 57
            break
        time.sleep(0.1)
    logger.info("Current timeslot starts at second: {}".format(last_timeslot_second))
    return last_timeslot_second


def get_obstruction_map_frame_type():
    context = starlink_grpc.ChannelContext(target=STARLINK_GRPC_ADDR_PORT)
    map = starlink_grpc.get_obstruction_map(context)
    if map.map_reference_frame == 0:
        frame_type = "UNKNOWN"
    elif map.map_reference_frame == 1:
        frame_type = "FRAME_EARTH"
    elif map.map_reference_frame == 2:
        frame_type = "FRAME_UT"
    return map.map_reference_frame, frame_type


def process_obstruction_estimate_satellites_per_timeslot(
    timeslot_df, writer, csvfile, filename, dt_string, date, frame_type_int, orientation
):
    logger.info("Processing obstruction map for the past timeslot")
    try:
        process_obstruction_timeslot(timeslot_df, writer)
        csvfile.flush()
        write_obstruction_map_parquet(filename, timeslot_df)

        if config.LATITUDE and config.LONGITUDE and config.ALTITUDE:
            if orientation:
                estimate_connected_satellites(
                    dt_string,
                    date,
                    frame_type_int,
                    orientation['tilt'],
                    orientation['azimuth'],
                    timeslot_df.iloc[0]["timestamp"],
                    timeslot_df.iloc[-1]["timestamp"],
                )
            else:
                logger.warning("No orientation data available, skipping satellite estimation.")

    except Exception as e:
        logger.error(f"Error in processing thread: {str(e)}")


def get_obstruction_map():
    name = "GRPC_GetObstructionMap"
    logger.info("{}, {}".format(name, threading.current_thread()))

    # Fetch orientation at the beginning of the cycle
    current_orientation = get_current_dish_orientation()
    # Generate dt_string here for filenames related to this cycle
    dt_string = date_time_string()

    date = ensure_data_directory(GRPC_DATA_DIR)
    FILENAME = f"{GRPC_DATA_DIR}/{date}/obstruction_map-{dt_string}.parquet"
    OBSTRUCTION_DATA_FILENAME = f"{DATA_DIR}/obstruction-data-{dt_string}.csv"
    TIMESLOT_DURATION = 14

    frame_type_int, frame_type_str = get_obstruction_map_frame_type()
    logger.info(f"Obstruction map frame type: {frame_type_str} ({frame_type_int})")

    start_time_measurement = time.time()
    thread_pool = []

    with open(OBSTRUCTION_DATA_FILENAME, "w", newline="") as csvfile:
        writer = csv.writer(csvfile)
        context = starlink_grpc.ChannelContext(target=STARLINK_GRPC_ADDR_PORT)
        last_timeslot_second = None

        while time.time() < start_time_measurement + DURATION_SECONDS:
            try:
                if last_timeslot_second is None:
                    now = datetime.now(timezone.utc)
                    if now.second >= 12 and now.second < 27:
                        start_time_slot = now.replace(microsecond=0).replace(second=27)
                        last_timeslot_second = 27
                    elif now.second >= 27 and now.second < 42:
                        start_time_slot = now.replace(microsecond=0).replace(second=42)
                        last_timeslot_second = 42
                    elif now.second >= 42 and now.second < 57:
                        start_time_slot = now.replace(microsecond=0).replace(second=57)
                        last_timeslot_second = 57
                    elif now.second >= 57 and now.second < 60:
                        start_time_slot = now.replace(microsecond=0).replace(
                            second=12
                        ) + timedelta(minutes=1)
                        last_timeslot_second = 12
                    elif now.second >= 0 and now.second < 12:
                        start_time_slot = now.replace(microsecond=0).replace(second=12)
                        last_timeslot_second = 12

                    while datetime.now(timezone.utc) < start_time_slot:
                        time.sleep(0.1)
                else:
                    last_timeslot_second = wait_until_target_time(last_timeslot_second)

                starlink_grpc.reset_obstruction_map(context)
                logger.info("Resetting dish obstruction map")
                timeslot_start = time.time()

                obstruction_data_array = []
                timestamp_array = []

                while time.time() < timeslot_start + TIMESLOT_DURATION:
                    obstruction_data = np.array(
                        starlink_grpc.obstruction_map(context), dtype=int
                    )
                    obstruction_data[obstruction_data == -1] = 0
                    obstruction_data = obstruction_data.flatten()

                    timestamp_array.append(time.time())
                    obstruction_data_array.append(obstruction_data)
                    time.sleep(0.5)

                timeslot_df = pd.DataFrame(
                    {
                        "timestamp": timestamp_array,
                        "frame_type": frame_type_int,
                        "obstruction_map": obstruction_data_array,
                    }
                )

                processing_thread = threading.Thread(
                    target=process_obstruction_estimate_satellites_per_timeslot,
                    args=(
                        timeslot_df,
                        writer,
                        csvfile,
                        FILENAME,
                        dt_string,
                        date,
                        frame_type_int,
                        current_orientation,
                    ),
                )
                processing_thread.start()
                thread_pool.append(processing_thread)

            except starlink_grpc.GrpcError as e:
                logger.error("Failed getting obstruction map data:", str(e))
            except Exception as e:
                 logger.error(f"Unexpected error in get_obstruction_map loop: {e}")

        logger.info("Measurement duration finished. Waiting for processing threads...")
        for thread in thread_pool:
            thread.join()
        logger.info("All processing threads finished.")


def write_obstruction_map_parquet(FILENAME, timeslot_df):
    if os.path.exists(FILENAME):
        existing_df = pd.read_parquet(FILENAME)
        combined_df = pd.concat([existing_df, timeslot_df], ignore_index=True)
        combined_df.to_parquet(
            FILENAME,
            engine="pyarrow",
            compression="zstd",
        )
    else:
        timeslot_df.to_parquet(
            FILENAME,
            engine="pyarrow",
            compression="zstd",
        )
    logger.info("Saved dish obstruction map to {}".format(FILENAME))


def estimate_connected_satellites(uuid, date, frame_type, tilt, azimuth, start, end):
    print(f"---> [{uuid}] ENTER estimate_connected_satellites") # DEBUG
    start_ts = datetime.fromtimestamp(start, tz=timezone.utc)
    end_ts = datetime.fromtimestamp(end, tz=timezone.utc)

    try:
        convert_observed(DATA_DIR, f"obstruction-data-{uuid}.csv", frame_type, tilt, azimuth)
        print(f"---> [{uuid}] convert_observed OK") # DEBUG
    except Exception as e:
        print(f"---> [{uuid}] ERROR in convert_observed: {e}") # DEBUG
        return

    filename = f"{DATA_DIR}/obstruction-data-{uuid}.csv"
    merged_data_file = f"{DATA_DIR}/processed_obstruction-data-{uuid}.csv"

    print(f"---> [{uuid}] Checking files: {filename}, {merged_data_file}") # DEBUG
    if not os.path.exists(filename): print(f"---> [{uuid}] MISSING: {filename}"); return # DEBUG
    if not os.path.exists(merged_data_file): print(f"---> [{uuid}] MISSING: {merged_data_file}"); return # DEBUG
    print(f"---> [{uuid}] All input files exist.") # DEBUG

    # --- Modified TLE file finding logic ---
    tle_dir_path = "{}/{}".format(TLE_DATA_DIR, date)
    if not os.path.exists(tle_dir_path):
        logger.error(f"[{uuid}] TLE directory not found: {tle_dir_path}")
        return

    # Find the latest TLE file in the directory for the given date
    list_of_files = glob.glob(os.path.join(tle_dir_path, 'starlink-tle-*.txt'))
    if not list_of_files:
        logger.error(f"[{uuid}] No TLE files found in: {tle_dir_path}")
        return
    latest_tle_file = max(list_of_files, key=os.path.getctime)
    print(f"---> [{uuid}] Using latest TLE file: {latest_tle_file}") # DEBUG
    # --- End Modified TLE file finding logic ---

    try:
        satellites = load.tle_file(latest_tle_file)
        print(f"---> [{uuid}] Loaded {len(satellites)} satellites.") # DEBUG
    except Exception as e:
        print(f"---> [{uuid}] ERROR loading TLE: {e}") # DEBUG
        return

    try:
        result_df = process_intervals(
            filename,
            start_ts.year, start_ts.month, start_ts.day, start_ts.hour, start_ts.minute, start_ts.second,
            end_ts.year, end_ts.month, end_ts.day, end_ts.hour, end_ts.minute, end_ts.second,
            merged_data_file, satellites, frame_type
        )
        print(f"---> [{uuid}] process_intervals shape: {result_df.shape}") # DEBUG
    except Exception as e:
        print(f"---> [{uuid}] ERROR in process_intervals: {e}") # DEBUG
        return

    if result_df.empty:
        print(f"---> [{uuid}] result_df is empty. Skipping.") # DEBUG
        return

    try:
        merged_data_df = pd.read_csv(merged_data_file, parse_dates=["Timestamp"])
        print(f"---> [{uuid}] merged_data_df shape: {merged_data_df.shape}") # DEBUG

        serving_data_path = f"{DATA_DIR}/serving_satellite_data-{uuid}.csv"

        print(f"---> [{uuid}] serving_data_path: {serving_data_path}") # DEBUG

        if os.path.exists(serving_data_path):
            existing_df = pd.read_csv(serving_data_path, parse_dates=["Timestamp"])
            print(f"---> [{uuid}] existing_df shape: {existing_df.shape}") # DEBUG
        else:
            existing_df = pd.DataFrame()
            print(f"---> [{uuid}] No existing serving data found.") # DEBUG

        merged_df = pd.merge(merged_data_df, result_df, on="Timestamp", how="inner")
        print(f"---> [{uuid}] Inner merge shape: {merged_df.shape}") # DEBUG

        if merged_df.empty:
             print(f"---> [{uuid}] merged_df is empty after inner merge. Skipping write.") # DEBUG
             return

        updated_df = pd.concat([existing_df, merged_df]).drop_duplicates(
            subset=["Timestamp"], keep="last"
        )
        print(f"---> [{uuid}] updated_df shape: {updated_df.shape}") # DEBUG

        updated_df.to_csv(serving_data_path, index=False)
        print(f"---> [{uuid}] Saved serving data to {serving_data_path}") # DEBUG

    except Exception as e:
        print(f"---> [{uuid}] ERROR in DataFrame processing/saving: {e}") # DEBUG
        return

    # --- Added: Write latest satellite name to file ---
    if not updated_df.empty:
        latest_satellite_name = updated_df.iloc[-1]["Connected_Satellite"]
        print(f"---> [{uuid}] Latest satellite name found: {latest_satellite_name}") # DEBUG
        if latest_satellite_name and isinstance(latest_satellite_name, str):
            try:
                os.makedirs(os.path.dirname(LATEST_SATELLITE_FILE), exist_ok=True)
                with open(LATEST_SATELLITE_FILE, 'w') as f:
                    f.write(latest_satellite_name)
                print(f"---> [{uuid}] Wrote {latest_satellite_name} to {LATEST_SATELLITE_FILE}") # DEBUG
            except Exception as e:
                print(f"---> [{uuid}] ERROR writing latest satellite file: {e}") # DEBUG
        else:
            print(f"---> [{uuid}] Could not determine latest satellite name from data (is None or not string).") # DEBUG
    else:
        print(f"---> [{uuid}] Cannot write latest satellite name, updated_df is empty.") # DEBUG
    # --- End Added ---
    print(f"---> [{uuid}] EXIT estimate_connected_satellites") # DEBUG
