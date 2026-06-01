/**
 * Audio Utilities
 *
 * Cross-platform audio: sound playback, TTS, VAD recording.
 * Handles Termux vs Linux differences transparently.
 */

import { execFile, exec } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Platform, VoiceConfig, VoiceProfile } from "./config";
import { getSoundPath, getExtensionDir } from "./config";

const TMP_BASE = join(homedir(), "tmp");

// ── Shell helpers ──

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      resolve((stdout || "").trim());
    });
  });
}

function shell(cmd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ── Platform-specific audio device flags ──

function getRecArgs(rate: number, channels: number): string[] {
  const platform = process.env.TERMUX_VERSION ? "termux" : process.platform;
  switch (platform) {
    case "termux":
    case "android":
      // Termux with PulseAudio - default device works
      return ["-r", String(rate), "-c", String(channels), "-e", "signed-integer", "-b", "16", "-t", "raw", "-"];
    case "linux":
      // Linux: try default device, PulseAudio/PipeWire/ALSA handled by sox
      return ["-r", String(rate), "-c", String(channels), "-e", "signed-integer", "-b", "16", "-t", "raw", "-"];
    case "darwin":
      return ["-r", String(rate), "-c", String(channels), "-e", "signed-integer", "-b", "16", "-t", "raw", "-"];
    default:
      return ["-r", String(rate), "-c", String(channels), "-e", "signed-integer", "-b", "16", "-t", "raw", "-"];
  }
}

// ── Sound Playback ──

export async function playSound(
  name: string,
  volume: number,
  masterVolume: number,
): Promise<void> {
  const path = getSoundPath(name);
  const effectiveVol = Math.max(0, Math.min(1, volume * masterVolume));
  try {
    await shell(`play -q -v ${effectiveVol.toFixed(2)} "${path}" 2>/dev/null`, 5000);
  } catch {
    // Silently fail - sound playback is non-critical
  }
}

// ── TTS (Text-to-Speech) ──

function buildEspeakPipeline(profile: VoiceProfile, text: string, ttsVolume: number, masterVolume: number): string {
  const safeVoice = profile.voice.replace(/"/g, "");
  const safeText = text.replace(/"/g, '\\"').replace(/`/g, "\\`");
  const effectiveVol = Math.max(0, Math.min(1, ttsVolume * masterVolume));

  const espeak = `espeak-ng -s ${profile.speed} -p ${profile.pitch} -a ${profile.amplitude} -v "${safeVoice}" --stdout "${safeText}"`;

  const soxEffects = [
    "reverb 30 20 60 80 60",
    "lowpass 7000",
    "highpass 80",
    "compand 0.05,0.05 -50,-50,-30,-20,-10,-5,0,0",
    `gain ${3 * effectiveVol}`,
  ].join(" ");

  return `${espeak} | sox - -t wav - ${soxEffects} 2>/dev/null | play -t wav - 2>/dev/null`;
}

function buildEdgeTtsPipeline(profile: VoiceProfile, text: string, ttsVolume: number, masterVolume: number): string {
  const safeVoice = profile.voice.replace(/"/g, "");
  const safeText = text.replace(/"/g, '\\"').replace(/`/g, "\\`");
  const effectiveVol = Math.max(0, Math.min(1, ttsVolume * masterVolume));
  // edge-tts --rate accepts "+20%" for faster, "-10%" for slower
  return `edge-tts --voice "${safeVoice}" --rate "+25%" --text "${safeText}" --write-media /tmp/pi_tts_out.mp3 2>/dev/null && ffplay -af "apad=pad_dur=0.5" -nodisp -autoexit -volume 100 /tmp/pi_tts_out.mp3 2>/dev/null`;
}

export async function speak(
  text: string,
  profile: VoiceProfile,
  ttsVolume: number,
  masterVolume: number,
): Promise<void> {
  let pipeline: string;
  if (profile.engine === "edge-tts") {
    pipeline = buildEdgeTtsPipeline(profile, text, ttsVolume, masterVolume);
  } else {
    pipeline = buildEspeakPipeline(profile, text, ttsVolume, masterVolume);
  }
  // Pipeline streams audio in real-time; ignore exit code since audio is already played
  try {
    await shell(pipeline, 30000);
  } catch {
    // Non-zero exit from piped play/ffplay is normal and harmless — audio already played
  }
}

// ── VAD Recording ──

export async function listenVad(
  vadAggressiveness: number,
  whisperBin: string,
  whisperModel: string,
  maxRecordSec: number,
  silenceFrames: number,
): Promise<{ wavFile: string; transcription: string }> {
  const id = randomUUID().slice(0, 8);
  const wavFile = join(TMP_BASE, `voice_${id}.wav`);
  const vadScript = join(getExtensionDir(), "vad_record.py");

  try {
    const recArgs = getRecArgs(16000, 1);
    await shell(
      `rec ${recArgs.join(" ")} 2>/dev/null | python3 "${vadScript}" "${wavFile}" ${vadAggressiveness} ${maxRecordSec} ${silenceFrames} 2>/dev/null`,
      (maxRecordSec + 5) * 1000
    );
  } catch {
    // Recording ended (timeout or VAD silence)
  }

  return { wavFile, transcription: "" };
}

export async function transcribeWav(
  wavFile: string,
  whisperBin: string,
  whisperModel: string,
): Promise<string> {
  let text = "";
  if (whisperBin && whisperModel) {
    try {
      text = await run(
        whisperBin,
        ["-m", whisperModel, "-f", wavFile, "-t", "3", "--no-timestamps"],
        30000
      );
    } catch {
      // Whisper failed
    }
  }
  return text;
}

export async function cleanupWav(wavFile: string): Promise<void> {
  try { await unlink(wavFile); } catch {}
}

// ── Utility: check if a command exists ──

export async function commandExists(cmd: string): Promise<boolean> {
  try {
    await run("which", [cmd], 3000);
    return true;
  } catch {
    return false;
  }
}

// ── Dependency Check ──

export interface DependencyStatus {
  name: string;
  found: boolean;
  path: string;
  required: boolean;
}

export async function checkDependencies(
  whisperBin: string,
  whisperModelStt: string,
  whisperModelWake: string,
): Promise<DependencyStatus[]> {
  const checks: DependencyStatus[] = [];

  for (const [name, required] of [
    ["play", true],
    ["rec", true],
    ["sox", true],
    ["espeak-ng", true],
    ["python3", true],
    ["whisper-cli", true],
  ] as [string, boolean][]) {
    let path = "";
    let found = false;
    try {
      path = await run("which", [name], 3000);
      found = !!path;
    } catch {}
    if (name === "whisper-cli" && !found && whisperBin) {
      found = true;
      path = whisperBin;
    }
    checks.push({ name, found, path, required });
  }

  // Check webrtcvad
  try {
    const out = await run("python3", ["-c", "import webrtcvad; print('ok')"], 5000);
    checks.push({ name: "webrtcvad (python)", found: out === "ok", path: "python3", required: true });
  } catch {
    checks.push({ name: "webrtcvad (python)", found: false, path: "", required: true });
  }

  // Check whisper model files
  checks.push({
    name: "whisper model (STT)",
    found: !!whisperModelStt,
    path: whisperModelStt || "not found",
    required: true,
  });
  checks.push({
    name: "whisper model (wake)",
    found: !!whisperModelWake,
    path: whisperModelWake || "not found",
    required: false,
  });

  // Check sound files
  for (const snd of ["ready", "done", "thinking", "listen", "success", "error"]) {
    const p = getSoundPath(snd);
    checks.push({
      name: `sound: ${snd}.wav`,
      found: require("node:fs").existsSync(p),
      path: p,
      required: false,
    });
  }

  return checks;
}
