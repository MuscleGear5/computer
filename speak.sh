#!/usr/bin/env bash
# speak — Edge TTS voice tool. Defaults to Guy (en-US), 1.25x rate.
# Flags (env vars, since this is invoked as a Hermes command TTS provider):
#   SPEAK_VOICE     override voice (default: en-US-GuyNeural)
#   SPEAK_RATE      override rate  (default: +25%)
#   SPEAK_LANG      en | fr  (default: en). fr → fr-CA-AntoineNeural unless
#                   SPEAK_VOICE is explicitly set.
#   SPEAK_FILE      if set, use --file "$SPEAK_FILE" instead of --text
# Designed to be invoked as a Hermes custom command TTS provider
# (tts.providers.speak.type=command in config.yaml).
set -euo pipefail

INPUT_PATH="${1:?speak: missing input text path}"
OUTPUT_PATH="${2:?speak: missing output audio path}"

# Pick voice: explicit SPEAK_VOICE wins; otherwise infer from SPEAK_LANG.
LANG="${SPEAK_LANG:-en}"
case "${LANG,,}" in
  fr|french|fr-ca|qc|quebec)
    DEFAULT_VOICE="fr-CA-AntoineNeural"
    ;;
  en|english|"")
    DEFAULT_VOICE="en-US-GuyNeural"
    ;;
  *)
    DEFAULT_VOICE="en-US-GuyNeural"
    ;;
esac

VOICE="${SPEAK_VOICE:-$DEFAULT_VOICE}"
RATE="${SPEAK_RATE:-+25%}"

mkdir -p "$(dirname "$OUTPUT_PATH")"

# --file mode lets callers (e.g. the tts-speak plugin, or hermes in --text mode)
# pass the text through whatever path works. The Hermes command-provider
# harness writes the input to a temp file and gives us its path as $1, so
# --file is the canonical way to read it.
if [ -n "${SPEAK_FILE:-}" ]; then
  edge-tts \
    --voice "$VOICE" \
    --rate "$RATE" \
    --file "$SPEAK_FILE" \
    --write-media "$OUTPUT_PATH"
else
  # Fallback: read directly from the path the harness gave us.
  # Edge TTS supports --text (single string) but not reading from an
  # arbitrary file unless --file is used, so we slurp it here.
  TEXT="$(cat "$INPUT_PATH")"
  edge-tts \
    --voice "$VOICE" \
    --rate "$RATE" \
    --text "$TEXT" \
    --write-media "$OUTPUT_PATH"
fi
