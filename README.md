# Starlink Map

[![Starlink Map Demo](https://img.youtube.com/vi/y3FMMHUy5OE/hqdefault.jpg)](https://www.youtube.com/watch?v=y3FMMHUy5OE)

_See what the map looks like in the video above!_

This project displays a map of all Starlink satellites, along with your currently connected satellite and the Starlink Point of Presence (PoP) you are connected through. You must be connected to your Starlink via Wi-Fi or Ethernet for this to show personalized data.

## Getting Started

1.  **Build the Docker image:**
    ```bash
    docker build -t starlink-map:latest .
    ```

2.  **Run the Docker container:**

    Replace `<your_latitude>`, `<your_longitude>`, and `<your_altitude>` with your actual location coordinates.

    ```bash
    docker run --rm -it -p 3000:3000 -p 3001:3001 --name starlink-map -e LAT="<your_latitude>" -e LON="<your_longitude>" -e ALT="<your_altitude>" starlink-map:latest
    ```
    *   `--rm`: Automatically remove the container when it exits (e.g., when you press CTRL+C).
    *   `-it`: Run in interactive mode and allocate a pseudo-TTY. This allows you to stop the container with CTRL+C.
    *   `-p 3000:3000`: Map host port 3000 to container port 3000 (for the web UI).
    *   `-p 3001:3001`: Map host port 3001 to container port 3001 (for the backend API).
    *   `--name starlink-map`: Assign a name to the container.
    *   `-e LAT="..."`: Set your latitude environment variable.
    *   `-e LON="..."`: Set your longitude environment variable.
    *   `-e ALT="..."`: Set your altitude environment variable.
    *   `starlink-map:latest`: The name and tag of the image to run.

3.  **Access the map:**
    Open your web browser and navigate to [http://localhost:3000](http://localhost:3000).

    _Note: It might take up to 30 seconds for satellite and connection data to populate after the container starts._

## Credits

This project utilizes data and code from the following open-source repositories:

-   [LEOViz](https://github.com/clarkzjw/LEOViz): Used for satellite visualization and determining which satellite the user is connected to.
-   [starlink-grpc-tools](https://github.com/sparky8512/starlink-grpc-tools): Used for interacting with the Starlink user terminal to get connection data.

Without the above two projects, this project would not have been possible.

## Project Structure

-   `src/`: Contains the Next.js frontend code for the map interface.
-   `starlink/`: Contains modified code from `LEOViz` and `starlink-grpc-tools` for querying the dish.
-   `Dockerfile`: Defines the Docker image build process.
-   `supervisord.conf`: Configuration for supervising the backend and frontend processes within the container.

## Contributing

Contributions are welcome! Feel free to open an issue or submit a pull request.