#!/bin/bash
# Chime for incoming USER MESSAGE
# Edit this file anytime - changes take effect immediately without restart
# Kill any in-progress speech so user message cuts through immediately.
# Match play processes using mp3 files from home dir (TTS audio).
# Does NOT match the chime wav since it uses wav not mp3.
# Use pgrep to find PIDs first, then kill them, to avoid pkill matching itself.
PIDS=$(pgrep -f "play.*\.mp3" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill 2>/dev/null
fi
# Also kill edge-tts generation in case it's still synthesizing
PIDS=$(pgrep -f "edge-tts.*write-media" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill 2>/dev/null
fi
# Also kill any ffplay (used by some speak paths)
pkill -x ffplay 2>/dev/null
timeout 5 play ~/chimes/trek4.wav vol -9 dB 2>/dev/null
