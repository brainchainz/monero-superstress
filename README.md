# Monero FCMP++ Stressnet - Umbrel App Directory

This directory contains the customized Tor-only Monero FCMP++ Stressnet app for Umbrel.

## How to Test on Umbrel

Since Umbrel requires pre-built images rather than building from source locally, we will build the images on your Mac and push them to Docker Hub.

### Step 1: Build & Push Images
Run the builder script to compile the stressnet `monerod` from source, package the web dashboard, and tag them for Docker Hub (`brainchainz` organization).
```bash
./build-image.sh
```
After building, push the images to Docker Hub:
```bash
docker push brainchainz/monero-stressnet:v0.19.0.0-alpha.1.5
docker push brainchainz/monero-fcmp-web:v1.0.0
```

### Step 2: Transfer App Config to Umbrel
You can use `scp` to copy this directory (which contains the `docker-compose.yml` and `umbrel-app.yml`) to your Umbrel server.
```bash
scp -r "monero-fcmp-stressnet" umbrel@umbrel.local:~/umbrel/app-data/
```

### Step 3: Run the App
SSH into your Umbrel, navigate to the folder, and run Docker Compose to pull the pre-built images and start the app:
```bash
ssh umbrel@umbrel.local
cd ~/umbrel/app-data/monero-fcmp-stressnet
docker-compose up -d
```

Open your browser to the Umbrel's IP address on the port defined in `docker-compose.yml` (default is 8080) to view the Premium Dashboard.
