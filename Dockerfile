# Dockerfile for Starlink Map Application - Simplified Build

# --- Stage 1: Node/Bun Dependencies & Source Code ---
FROM oven/bun:latest AS node-base
WORKDIR /app

# Copy dependency files
COPY package.json bun.lock ./

# Install Node.js dependencies using Bun (including dev dependencies)
RUN bun install

# --- Stage 2: Final Runtime Image ---
FROM oven/bun:latest AS final
WORKDIR /app

# Install runtime dependencies: Python3, Pip, Supervisor, Git
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        supervisor \
        git \
        build-essential \
        python3-dev \
        curl \
        dnsutils && \
    rm -rf /var/lib/apt/lists/*

# Download and install grpcurl
ARG GRPCURL_VERSION=1.9.3
RUN curl -sSL "https://github.com/fullstorydev/grpcurl/releases/download/v${GRPCURL_VERSION}/grpcurl_${GRPCURL_VERSION}_linux_x86_64.tar.gz" \
    | tar -xz -C /usr/local/bin grpcurl && \
    chmod +x /usr/local/bin/grpcurl

# Copy application code and node_modules from the node-base stage
COPY --from=node-base /app /app

# Verify python3 installation
RUN which python3
RUN python3 --version

# Copy requirements file first (for better caching)
COPY ./starlink/starlink-grpc-tools/requirements.txt /app/starlink/starlink-grpc-tools/

# Install Python dependencies globally, overriding PEP 668
RUN pip3 install --no-cache-dir --break-system-packages -r /app/starlink/starlink-grpc-tools/requirements.txt

# Copy the rest of the application code
COPY . /app

# Configure and run
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Expose ports
EXPOSE 3000
EXPOSE 3001

# Start supervisord
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"] 