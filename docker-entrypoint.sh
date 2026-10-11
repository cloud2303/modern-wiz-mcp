#!/bin/sh
set -e
mkdir -p /app/.data/writes
chown -R node:node /app/.data
exec runuser -u node -- node /app/dist/main.js
