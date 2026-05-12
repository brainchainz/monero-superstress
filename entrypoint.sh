#!/bin/sh
# Ensure data directories exist inside the mounted volume.
# On a fresh Umbrel install the host volume is empty, so monerod
# would fail with "Permission denied" trying to create subdirs.
mkdir -p /home/monero/.bitmonero/testnet
mkdir -p /home/monero/wallet

exec monerod "$@"
