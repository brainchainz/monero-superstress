#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# Monero FCMP++ Stressnet — Multi-arch Docker build & push
#
# Usage:
#   ./build-image.sh          # Build + push both images
#   ./build-image.sh web      # Build + push web image only
#   ./build-image.sh monerod  # Build + push monerod image only
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

DOCKER_ORG="sirjamzalot"
MONERO_TAG="${DOCKER_ORG}/monero-stressnet:latest"
WEB_TAG="${DOCKER_ORG}/monero-stressnet-web:latest"

# Ensure buildx builder exists
if ! docker buildx inspect multiarch >/dev/null 2>&1; then
    echo "[build] Creating buildx builder 'multiarch'..."
    docker buildx create --name multiarch --use
else
    docker buildx use multiarch
fi

build_monerod() {
    echo ""
    echo "═══════════════════════════════════════════════════════"
    echo "  Building monerod (FCMP++ stressnet) — multi-arch"
    echo "  WARNING: Compiles from source. This takes 30-60 min."
    echo "═══════════════════════════════════════════════════════"
    echo ""
    docker buildx build \
        --platform linux/amd64,linux/arm64 \
        -f Dockerfile.monero \
        -t "${MONERO_TAG}" \
        --push \
        .
    echo "[build] Pushed ${MONERO_TAG}"
}

build_web() {
    echo ""
    echo "═══════════════════════════════════════════════════════"
    echo "  Building stressnet web dashboard — multi-arch"
    echo "═══════════════════════════════════════════════════════"
    echo ""
    docker buildx build \
        --platform linux/amd64,linux/arm64 \
        -f web/Dockerfile \
        -t "${WEB_TAG}" \
        --push \
        ./web
    echo "[build] Pushed ${WEB_TAG}"
}

case "${1:-all}" in
    web)     build_web ;;
    monerod) build_monerod ;;
    all)     build_monerod; build_web ;;
    *)       echo "Usage: $0 [web|monerod|all]"; exit 1 ;;
esac

echo ""
echo "Done! Images on Docker Hub:"
echo "  ${MONERO_TAG}"
echo "  ${WEB_TAG}"
