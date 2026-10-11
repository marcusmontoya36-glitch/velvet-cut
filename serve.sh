#!/usr/bin/env sh
# Serve Velvet Cut locally (ES modules + service worker need http://, not file://)
cd "$(dirname "$0")" && echo "Open http://localhost:${1:-8080}" && python3 -m http.server "${1:-8080}"
