#!/bin/bash
# Chime for COUNCIL TOOL CALL starting
# Plays the specific council chime based on the tool name passed as $1
# Edit this file anytime - changes take effect immediately without restart
CHIME_DIR=~/chimes

case "$1" in
    council_query|council_evaluate|council_gate|council_review_diff|council_review_claim|council_review_plan|council_decision|council_preflight)
        timeout 3 play "$CHIME_DIR/$1.wav" vol -9 dB 2>/dev/null
        ;;
    *)
        # Unknown council tool - use the query chime
        timeout 3 play "$CHIME_DIR/council_query.wav" vol -9 dB 2>/dev/null
        ;;
esac
