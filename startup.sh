#!/bin/sh
set -eu

# The application checks Redis, starts HTTP, then schedules background work.
# Authentication is handled lazily by the application when upstream data is needed.
exec bun src/index.ts "$@"
