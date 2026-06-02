/**
 * whisper-listen
 *
 * Replaces the built-in listen tool with a faster-whisper based implementation.
 * Plays notification beeps (rising = recording start, descending = recording stop)
 * then transcribes the recorded audio and returns the text.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

const LISTEN_PARAMS = Type.Object({
	duration: Type.Optional(
		Type.Number({
			description: "Recording duration in seconds (default: 10)",
			minimum: 2,
			maximum: 60,
		})
	),
});

const START_BEEP = "/tmp/listen_start.wav";
const STOP_BEEP = "/tmp/listen_stop.wav";
const AUDIO_FILE = "/tmp/whisper_input.wav";

function ensureBeeps(): void {
	if (!require("node:fs").existsSync(START_BEEP)) {
		execSync(
			`sox -n -q -r 22050 "${START_BEEP}" synth 0.18 sine 880 synth 0.18 sine 1320 fade 0.01 0.18 0.02`,
			{ stdio: "ignore" }
		);
	}
	if (!require("node:fs").existsSync(STOP_BEEP)) {
		execSync(
			`sox -n -q -r 22050 "${STOP_BEEP}" synth 0.2 sine 1320 synth 0.2 sine 880 fade 0.01 0.2 0.03`,
			{ stdio: "ignore" }
		);
	}
}

export default function whisperListenExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "listen",
		label: "Listen (Whisper)",
		description:
			"Listen to the user with voice activity detection. Plays ready tone before recording and done tone after. Transcribes with faster-whisper and returns text.",
		promptSnippet:
			"Use listen to capture the user's voice response. Plays notification beeps to signal recording start/stop.",
		promptGuidelines: [
			"Use listen when you need to hear the user's spoken response.",
			"The tool plays a rising beep to signal recording start and a descending beep when done.",
			"After getting transcription, respond using the speak tool.",
		],
		parameters: LISTEN_PARAMS,
		async execute(_toolCallId, params) {
			const duration = params.duration ?? 10;
			ensureBeeps();

			try {
				// Play start beep (non-blocking)
				execSync(`play -q "${START_BEEP}" &>/dev/null &`, {
					shell: "/bin/bash",
					stdio: "ignore",
				});

				// Record
				execSync(
					`rec -q -r 16000 -c 1 "${AUDIO_FILE}" trim 0 ${duration}`,
					{ shell: "/bin/bash", stdio: "ignore", timeout: (duration + 5) * 1000 }
				);

				// Play stop beep (non-blocking)
				execSync(`play -q "${STOP_BEEP}" &>/dev/null &`, {
					shell: "/bin/bash",
					stdio: "ignore",
				});

				// Transcribe with faster-whisper
				const script = `
from faster_whisper import WhisperModel
model = WhisperModel('base', device='cpu', compute_type='int8')
segments, info = model.transcribe('${AUDIO_FILE}', beam_size=5)
text = ' '.join(seg.text.strip() for seg in segments if seg.text.strip())
print(text if text else '[no speech detected]')
`;
				const result = execSync(`python3 -c ${JSON.stringify(script)}`, {
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
					timeout: 30000,
				}).trim();

				return {
					content: [{ type: "text", text: result || "[no speech detected]" }],
					details: { tool: "listen", duration, transcription: result },
				};
			} finally {
				// Clean up
				try {
					require("node:fs").unlinkSync(AUDIO_FILE);
				} catch {}
			}
		},
	});
}
