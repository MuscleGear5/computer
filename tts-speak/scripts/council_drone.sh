#!/bin/bash
# Loop the council working drone for up to 120 seconds
# Started by pre_tool_call when a council tool runs, killed by post_tool_call
DRONE_FILE=~/chimes/council_working.wav
if [ ! -f "$DRONE_FILE" ]; then
    exit 0
fi
# Loop play with fade between iterations, kill-safe
start=$(date +%s)
while true; do
    now=$(date +%s)
    elapsed=$((now - start))
    if [ "$elapsed" -ge 120 ]; then
        break
    fi
    timeout 3 play "$DRONE_FILE" vol -9 dB 2>/dev/null
done
