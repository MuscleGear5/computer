/**
 * Voice System Configuration
 *
 * Manages platform detection, defaults, and user config loading.
 * Config file: ~/.pi/agent/extensions/voice-system/config.json
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ── Platform Detection ──

export type Platform = "termux" | "linux" | "macos" | "unknown";

export function detectPlatform(): Platform {
  if (process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux")) {
    return "termux";
  }
  if (process.platform === "darwin") {
    return "macos";
  }
  if (process.platform === "linux") {
    return "linux";
  }
  return "unknown";
}

// ── Voice Profile ──

export interface VoiceProfile {
  /** TTS engine: "espeak-ng" or "edge-tts" */
  engine: "espeak-ng" | "edge-tts";
  /** Voice identifier — espeak-ng variant (e.g. "en-gb-x-rp") or edge-tts voice name (e.g. "en-US-BrianNeural") */
  voice: string;
  /** Speed in words per minute (espeak-ng) or rate string for edge-tts */
  speed: number;
  /** Pitch 0-99 (default 30) */
  pitch: number;
  /** Amplitude 0-200 (default 100) */
  amplitude: number;
  /** Language code for STT whisper model selection */
  sttLanguage: string;
  /** Display label */
  label: string;
}

export const VOICE_PROFILES: Record<string, VoiceProfile> = {
  "computer-en": {
    engine: "espeak-ng",
    voice: "en-gb-x-rp",
    speed: 150,
    pitch: 30,
    amplitude: 100,
    sttLanguage: "en",
    label: "Computer (English RP)",
  },
  "computer-fr": {
    engine: "espeak-ng",
    voice: "fr-ca",
    speed: 150,
    pitch: 30,
    amplitude: 100,
    sttLanguage: "fr",
    label: "Computer (French Canadian)",
  },
  "brian": {
    engine: "edge-tts",
    voice: "en-US-BrianNeural",
    speed: 150,
    pitch: 30,
    amplitude: 100,
    sttLanguage: "en",
    label: "Brian (Edge TTS)",
  },
};

// ── Sound Volume ──

export interface SoundVolumes {
  ready: number;
  done: number;
  thinking: number;
  listen: number;
  success: number;
  error: number;
}

// ── Main Config ──

export interface VoiceConfig {
  /** Active voice profile name */
  profile: string;
  /** Whisper binary path (auto-detected if empty) */
  whisperBin: string;
  /** Whisper model path for STT (listening) */
  whisperModelStt: string;
  /** Whisper model path for wake word (tiny, faster) */
  whisperModelWake: string;
  /** VAD aggressiveness 0-3 (default 3) */
  vadAggressiveness: number;
  /** Sound effect volumes 0.0-1.0 */
  volumes: SoundVolumes;
  /** TTS volume multiplier */
  ttsVolume: number;
  /** Master volume 0.0-1.0 */
  masterVolume: number;
  /** Maximum recording duration in seconds */
  maxRecordSec: number;
  /** Silence frames after speech to end recording */
  silenceFrames: number;
  /** Wake word (default "computer") */
  wakeWord: string;
  /** Enable wake word daemon */
  wakeEnabled: boolean;
}

export const DEFAULT_CONFIG: VoiceConfig = {
  profile: "computer-en",
  whisperBin: "",
  whisperModelStt: "",
  whisperModelWake: "",
  vadAggressiveness: 3,
  volumes: {
    ready: 0.5,
    done: 0.45,
    thinking: 0.35,
    listen: 0.5,
    success: 0.4,
    error: 0.4,
  },
  ttsVolume: 1.0,
  masterVolume: 1.0,
  maxRecordSec: 30,
  silenceFrames: 70,
  wakeWord: "computer",
  wakeEnabled: false,
};

// ── Paths ──

const EXT_DIR = join(homedir(), ".pi", "agent", "extensions", "computer");
const CONFIG_FILE = join(EXT_DIR, "config.json");

export function getExtensionDir(): string {
  return EXT_DIR;
}

export function getConfigFile(): string {
  return CONFIG_FILE;
}

export function getSoundsDir(): string {
  return join(EXT_DIR, "sounds");
}

// ── Sound file resolution: bundled first, fallback to atoms ──

export function getSoundPath(name: string): string {
  const bundled = join(getSoundsDir(), `${name}.wav`);
  if (existsSync(bundled)) return bundled;
  const atoms = join(homedir(), ".pi", "sounds", "atoms", `${name}.wav`);
  if (existsSync(atoms)) return atoms;
  return bundled; // will fail gracefully
}

// ── Whisper path resolution ──

const WHISPER_SEARCH_PATHS = [
  join(homedir(), "tmp", "whisper.cpp", "build", "bin", "whisper-cli"),
  join(homedir(), ".local", "bin", "whisper-cli"),
  "/usr/local/bin/whisper-cli",
  "/usr/bin/whisper-cli",
];

const WHISPER_MODEL_SEARCH = {
  stt: [
    join(homedir(), "tmp", "whisper.cpp", "models", "ggml-base.en.bin"),
    join(homedir(), ".local", "share", "whisper", "ggml-base.en.bin"),
  ],
  wake: [
    join(homedir(), "tmp", "whisper.cpp", "models", "ggml-tiny.en.bin"),
    join(homedir(), ".local", "share", "whisper", "ggml-tiny.en.bin"),
  ],
};

export function findWhisperBin(): string {
  for (const p of WHISPER_SEARCH_PATHS) {
    if (existsSync(p)) return p;
  }
  return "";
}

export function findWhisperModel(type: "stt" | "wake"): string {
  for (const p of WHISPER_MODEL_SEARCH[type]) {
    if (existsSync(p)) return p;
  }
  return "";
}

// ── Config Load/Save ──

export function loadConfig(): VoiceConfig {
  const cfg = { ...DEFAULT_CONFIG };
  if (!existsSync(CONFIG_FILE)) {
    // First run: auto-detect whisper paths
    cfg.whisperBin = findWhisperBin();
    cfg.whisperModelStt = findWhisperModel("stt");
    cfg.whisperModelWake = findWhisperModel("wake");
    saveConfig(cfg);
    return cfg;
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Partial<VoiceConfig>;
    Object.assign(cfg, raw);
    // Fill missing volume keys
    cfg.volumes = { ...DEFAULT_CONFIG.volumes, ...raw.volumes };
    return cfg;
  } catch {
    return cfg;
  }
}

export function saveConfig(cfg: VoiceConfig): void {
  mkdirSync(EXT_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

// ── Resolved config (with auto-detection fallbacks) ──

export function resolveConfig(cfg: VoiceConfig) {
  const platform = detectPlatform();
  const profile = VOICE_PROFILES[cfg.profile] ?? VOICE_PROFILES["computer-en"];

  return {
    platform,
    profile,
    whisperBin: cfg.whisperBin || findWhisperBin(),
    whisperModelStt: cfg.whisperModelStt || findWhisperModel("stt"),
    whisperModelWake: cfg.whisperModelWake || findWhisperModel("wake"),
    config: cfg,
  };
}
