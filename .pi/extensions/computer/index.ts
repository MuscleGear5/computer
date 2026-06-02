/**
 * Computer - Unified Voice & Sound System for Pi
 *
 * A complete voice interaction system bundled as a single pi extension.
 * Cross-platform: works on Termux/Android and Linux desktop.
 *
 * Tools:
 *   speak     - TTS with ready/done sound cues (no recording)
 *   listen    - VAD-based recording with chime, transcribe via Whisper (no TTS)
 *   speak_and_listen - Combined: speaks text, drains audio, then listens (no overlap)
 *   bg_agent  - Spawn a background pi agent (non-blocking)
 *   check_agent - Check status/results of a background agent
 *
 * Commands:
 *   /voice-check   - Check all voice system dependencies
 *   /voice-config  - Show current voice configuration
 *   /voice-profile - Switch voice profile (en/fr)
 *   /wake-start    - Start the wake word daemon
 *   /wake-stop     - Stop the wake word daemon
 *   /wake-status   - Check wake word daemon status
 *
 * Sound scheme:
 *   ready    - ascending tone before Computer speaks
 *   done     - descending tone after Computer finishes (user's turn)
 *   thinking - processing hum while Computer works
 *   listen   - crisp chime signaling user to speak
 *   success  - pleasant chime on task completion
 *   error    - harsh buzz on failure
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs/promises";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  detectPlatform,
  loadConfig,
  saveConfig,
  resolveConfig,
  getExtensionDir,
  getSoundPath,
  VOICE_PROFILES,
  type VoiceConfig,
} from "./config";

import {
  playSound,
  speak,
  listenVad,
  transcribeWav,
  cleanupWav,
  checkDependencies,
} from "./audio";

const TASKS_DIR = join(homedir(), ".pi", "agent", "tasks");

// ── Extension Entry Point ──

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();
  const resolved = resolveConfig(cfg);

  // ── Enforce speak/listen behavior via system prompt ──
  pi.on("before_agent_start", async (event) => {
    const reminder = `

*** MANDATORY BEHAVIOR — NO EXCEPTIONS ***
1. You MUST call the speak() tool with your response text BEFORE outputting any JSON response. Every. Single. Time. No exceptions.
2. You MUST call the listen() tool AFTER asking any question or expecting user input. Every. Single. Time. No exceptions.
3. These two rules apply to EVERY response you generate, without exception.
4. If you output a JSON response without having called speak() in the same turn, you are FAILING.
5. If you ask a question or expect input without calling listen() in the same turn, you are FAILING.
*** END MANDATORY BEHAVIOR ***`;

    return {
      systemPrompt: event.systemPrompt + reminder,
    };
  });


  // Notify on load
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      const platform = resolved.platform;
      const profile = resolved.profile.label;
      ctx.ui.setStatus("voice", `🎙 ${profile} [${platform}]`);
    }
  });

  pi.on("session_shutdown", async () => {
    // Could stop wake word daemon here if desired
  });

  // ══════════════════════════════════════════════════════════
  //  TOOL: speak
  // ══════════════════════════════════════════════════════════

  pi.registerTool({
    name: "speak",
    label: "Speak",
    description: "Speak text aloud as Computer. Plays ready tone before speaking and done tone after. Does NOT record.",
    promptSnippet: "Speak text aloud as Computer with sound cues (TTS only, no recording)",
    promptGuidelines: [
      "Use the speak tool to say things out loud to the user.",
      "Always speak your responses aloud before typing them.",
      "The speak tool plays a ready tone before and a done tone after.",
      "The speak tool does NOT record audio.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "The text to speak aloud" }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const text = params.text;

      if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };

      // Ready tone
      await playSound("ready", cfg.volumes.ready, cfg.masterVolume);
      if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };

      onUpdate?.({ content: [{ type: "text", text: "Speaking..." }] });

      try {
        await speak(text, resolved.profile, cfg.ttsVolume, cfg.masterVolume);
      } catch {
        await playSound("error", cfg.volumes.error, cfg.masterVolume);
        return {
          content: [{ type: "text", text: "(TTS failed)" }],
          details: { error: true },
        };
      }

      // Done tone - signals user's turn
      await playSound("done", cfg.volumes.done, cfg.masterVolume);

      return {
        content: [{ type: "text", text: `Spoke: "${text}"` }],
        details: { spoke: text },
      };
    },
  });

  // ══════════════════════════════════════════════════════════
  //  TOOL: listen
  // ══════════════════════════════════════════════════════════

  pi.registerTool({
    name: "listen",
    label: "Listen",
    description: "Listen to the user with voice activity detection. Plays listen chime, records until user stops talking, transcribes. No TTS.",
    promptSnippet: "Listen to user with VAD and transcribe (no TTS)",
    promptGuidelines: [
      "Use the listen tool when you need to hear the user's response.",
      "Always use speak first to tell the user you are about to listen.",
      "The listen tool uses voice activity detection.",
      "If transcription fails or is inaudible, it waits 30s and retries once.",
      "After getting transcription, respond using the speak tool.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, signal, onUpdate, _ctx) {
      if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };

      // Thinking tone
      await playSound("thinking", cfg.volumes.thinking, cfg.masterVolume);
      // Listen chime
      await playSound("listen", cfg.volumes.listen, cfg.masterVolume);

      if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };

      onUpdate?.({ content: [{ type: "text", text: "Listening (VAD)..." }] });
      const { wavFile } = await listenVad(
        cfg.vadAggressiveness,
        resolved.whisperBin,
        resolved.whisperModelStt,
        cfg.maxRecordSec,
        cfg.silenceFrames,
        signal,
      );

      // Done tone - immediately after recording stops, before transcription
      await playSound("done", cfg.volumes.done, cfg.masterVolume);

      let transcription = await transcribeWav(wavFile, resolved.whisperBin, resolved.whisperModelStt);
      await cleanupWav(wavFile);

      // Done tone - signals mic is closed and transcription is ready
      await playSound("done", cfg.volumes.done, cfg.masterVolume);

      // Retry once if inaudible
      if (!transcription || transcription.includes("[inaudible]")) {
        onUpdate?.({ content: [{ type: "text", text: "Could not hear. Waiting 30s and retrying..." }] });
        await playSound("thinking", cfg.volumes.thinking, cfg.masterVolume);
        await new Promise(r => setTimeout(r, 30000));
        if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };

        await playSound("listen", cfg.volumes.listen, cfg.masterVolume);
        const { wavFile: retryWav } = await listenVad(
          cfg.vadAggressiveness,
          resolved.whisperBin,
          resolved.whisperModelStt,
          cfg.maxRecordSec,
          cfg.silenceFrames,
          signal,
        );
        await playSound("done", cfg.volumes.done, cfg.masterVolume);
        const retry = await transcribeWav(retryWav, resolved.whisperBin, resolved.whisperModelStt);
        await cleanupWav(retryWav);

        if (!retry || retry.includes("[inaudible]")) {
          await playSound("error", cfg.volumes.error, cfg.masterVolume);
          return {
            content: [{ type: "text", text: "(Could not hear, user may be busy)" }],
            details: { transcription: retry || "" },
          };
        }
        transcription = retry;
      }

      return {
        content: [{ type: "text", text: transcription }],
        details: { transcription },
      };
    },
  });

  // ══════════════════════════════════════════════════════════
  //  TOOL: speak_and_listen
  // ══════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "speak_and_listen",
    label: "Speak and Listen",
    description: "Speak text aloud then automatically listen for a response. Combined tool that eliminates speak→listen race conditions. Speaks with ready/done tones, drains audio buffer, then opens mic with VAD and transcribes.",
    promptSnippet: "Speak then listen - combined tool that prevents audio overlap",
    promptGuidelines: [
      "Use speak_and_listen when you want to say something AND hear a response in one step.",
      "This tool speaks your text, waits for audio to fully drain, then listens.",
      "No race condition possible since speak and listen are in the same tool.",
      "Use this instead of calling speak then listen separately.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "The text to speak aloud before listening" }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const text = params.text;

      if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };

      // Ready tone
      await playSound("ready", cfg.volumes.ready, cfg.masterVolume);
      if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };

      onUpdate?.({ content: [{ type: "text", text: "Speaking..." }] });

      try {
        await speak(text, resolved.profile, cfg.ttsVolume, cfg.masterVolume);
      } catch {
        await playSound("error", cfg.volumes.error, cfg.masterVolume);
        return {
          content: [{ type: "text", text: "(TTS failed)" }],
          details: { error: true },
        };
      }

      // Done tone - signals TTS is complete, user's turn next
      await playSound("done", cfg.volumes.done, cfg.masterVolume);

      // Audio buffer is drained by ffplay apad filter in the TTS pipeline.
      // Wait to ensure complete silence before switching to mic input.
      await new Promise(r => setTimeout(r, 600));

      if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };

      // Listen chime - clear signal to user that mic is now open
      await playSound("listen", cfg.volumes.listen, cfg.masterVolume);

      if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };

      onUpdate?.({ content: [{ type: "text", text: "Listening (VAD)..." }] });
      const { wavFile } = await listenVad(
        cfg.vadAggressiveness,
        resolved.whisperBin,
        resolved.whisperModelStt,
        cfg.maxRecordSec,
        cfg.silenceFrames,
        signal,
      );

      // Done tone - immediately after recording stops, before transcription
      await playSound("done", cfg.volumes.done, cfg.masterVolume);

      let transcription = await transcribeWav(wavFile, resolved.whisperBin, resolved.whisperModelStt);
      await cleanupWav(wavFile);

      // Done tone - signals mic is closed and transcription is ready
      await playSound("done", cfg.volumes.done, cfg.masterVolume);

      // Retry once if inaudible
      if (!transcription || transcription.includes("[inaudible]")) {
        onUpdate?.({ content: [{ type: "text", text: "Could not hear. Waiting 30s and retrying..." }] });
        await playSound("thinking", cfg.volumes.thinking, cfg.masterVolume);
        await new Promise(r => setTimeout(r, 30000));
        if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };

        await playSound("listen", cfg.volumes.listen, cfg.masterVolume);
        const { wavFile: retryWav } = await listenVad(
          cfg.vadAggressiveness,
          resolved.whisperBin,
          resolved.whisperModelStt,
          cfg.maxRecordSec,
          cfg.silenceFrames,
          signal,
        );
        await playSound("done", cfg.volumes.done, cfg.masterVolume);
        const retry = await transcribeWav(retryWav, resolved.whisperBin, resolved.whisperModelStt);
        await cleanupWav(retryWav);

        if (!retry || retry.includes("[inaudible]")) {
          await playSound("error", cfg.volumes.error, cfg.masterVolume);
          return {
            content: [{ type: "text", text: "(Could not hear, user may be busy)" }],
            details: { transcription: retry || "" },
          };
        }
        transcription = retry;
      }

      return {
        content: [{ type: "text", text: transcription }],
        details: { transcription, spoke: text },
      };
    },
  });

  // ══════════════════════════════════════════════════════════
  //  TOOL: bg_agent
  // ══════════════════════════════════════════════════════════

  pi.registerTool({
    name: "bg_agent",
    label: "Background Agent",
    description:
      "Spawn a background pi agent to do work in a separate process. This does NOT block the conversation - you can keep talking to the user while the agent works. The result is written to a file and can be checked later with check_agent.",
    promptSnippet: "Spawn a non-blocking background agent for long tasks (does not block conversation)",
    promptGuidelines: [
      "Use bg_agent when you need to do work that takes a long time but still want to keep talking to the user.",
      "The agent runs in a separate process and does not block the current turn.",
      "Use check_agent to check on the status and results of a background agent.",
      "Play the thinking sound before spawning, and the success sound will play when done.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "The task/prompt to send to the background agent" }),
      label: Type.Optional(Type.String({ description: "A short label for this task" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const prompt = params.prompt;
      const label = params.label || "task";
      const taskId = `${label}-${randomUUID().slice(0, 6)}`;
      const outFile = join(TASKS_DIR, `${taskId}.txt`);
      const statusFile = join(TASKS_DIR, `${taskId}.status`);

      if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };

      await playSound("thinking", cfg.volumes.thinking, cfg.masterVolume);
      onUpdate?.({ content: [{ type: "text", text: `Spawning background agent: ${taskId}...` }] });

      const safePrompt = prompt.replace(/"/g, '\\"').replace(/'/g, "'\\''");
      const bgCmd = `nohup bash -c 'echo "${safePrompt}" | pi -p --no-session 2>/dev/null > "${outFile}"; echo "DONE" > "${statusFile}"' > /dev/null 2>&1 & echo $!`;

      try {
        const { execSync } = await import("node:child_process");
        const { writeFileSync: wfs } = await import("node:fs");
        const pid = execSync(bgCmd, { timeout: 5000 }).toString().trim();
        mkdirSync(TASKS_DIR, { recursive: true });
        wfs(statusFile, `RUNNING (PID: ${pid})`);
      } catch {
        await playSound("error", cfg.volumes.error, cfg.masterVolume);
        return {
          content: [{ type: "text", text: "Failed to spawn background agent" }],
          details: { error: true },
        };
      }

      return {
        content: [{ type: "text", text: `Background agent spawned: ${taskId}. Working in background. Use check_agent to see results.` }],
        details: { taskId, outFile, statusFile },
      };
    },
  });

  // ══════════════════════════════════════════════════════════
  //  TOOL: check_agent
  // ══════════════════════════════════════════════════════════

  pi.registerTool({
    name: "check_agent",
    label: "Check Agent",
    description: "Check the status and results of a background agent spawned with bg_agent.",
    promptSnippet: "Check status and results of a background agent",
    promptGuidelines: [
      "Use check_agent to see if a background agent is done and get its results.",
    ],
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID returned by bg_agent" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const taskId = params.task_id;
      const statusFile = join(TASKS_DIR, `${taskId}.status`);
      const outFile = join(TASKS_DIR, `${taskId}.txt`);

      let status = "UNKNOWN";
      try { status = (await readFileSync(statusFile, "utf-8")).trim(); } catch {}

      let output = "";
      try { output = (await readFileSync(outFile, "utf-8")).trim(); } catch {}

      if (status.startsWith("DONE")) {
        await playSound("success", cfg.volumes.success, cfg.masterVolume);
        return {
          content: [{ type: "text", text: `Agent ${taskId} COMPLETED.\n\n${output}` }],
          details: { taskId, status: "done", output },
        };
      }

      await playSound("thinking", cfg.volumes.thinking, cfg.masterVolume);
      return {
        content: [{ type: "text", text: `Agent ${taskId} still running. Status: ${status}\n\nPartial output:\n${output || "(no output yet)"}` }],
        details: { taskId, status: "running", output },
      };
    },
  });

  // ══════════════════════════════════════════════════════════
  //  COMMANDS
  // ══════════════════════════════════════════════════════════

  // /voice-check - Dependency health check
  pi.registerCommand("voice-check", {
    description: "Check voice system dependencies and configuration",
    handler: async (_args, ctx) => {
      const deps = await checkDependencies(
        resolved.whisperBin,
        resolved.whisperModelStt,
        resolved.whisperModelWake,
      );

      const lines: string[] = [
        `🎙 Voice System Check [${resolved.platform}]`,
        `   Profile: ${resolved.profile.label}`,
        `   Whisper: ${resolved.whisperBin || "NOT FOUND"}`,
        "",
        "Dependencies:",
      ];

      let allOk = true;
      for (const d of deps) {
        const icon = d.found ? "✓" : d.required ? "✗" : "○";
        const tag = d.required ? "" : " (optional)";
        lines.push(`  ${icon} ${d.name}${tag}`);
        if (!d.found && d.required) allOk = false;
        if (d.found && d.path) {
          lines.push(`     ${d.path}`);
        }
      }

      lines.push("");
      if (allOk) {
        lines.push("All required dependencies satisfied ✓");
      } else {
        lines.push("Some required dependencies missing! Run setup.sh to install.");
      }

      ctx.ui.notify(allOk ? "Voice system OK" : "Voice system has issues", allOk ? "info" : "warning");

      if (ctx.hasUI) {
        const { Text } = await import("@mariozechner/pi-tui");
        ctx.ui.custom<void>((_tui, theme, _kb, done) => {
          const content = lines.map(l => theme.fg("muted", l)).join("\n");
          const comp = new Text(content, 0, 0);
          comp.onKey = (_key) => { done(); return true; };
          return comp;
        }, { overlay: true });
      }
    },
  });

  // /voice-config - Show current config
  pi.registerCommand("voice-config", {
    description: "Show current voice configuration",
    handler: async (_args, ctx) => {
      const current = loadConfig();
      const r = resolveConfig(current);

      const lines = [
        "🎙 Voice System Configuration",
        "",
        `Platform:      ${r.platform}`,
        `Profile:       ${current.profile} (${r.profile.label})`,
        "",
        `Voice:         ${r.profile.voice}`,
        `Speed:         ${r.profile.speed} wpm`,
        `Pitch:         ${r.profile.pitch}`,
        `Amplitude:     ${r.profile.amplitude}`,
        `STT Language:  ${r.profile.sttLanguage}`,
        "",
        `Whisper Bin:   ${r.whisperBin || "(auto-detect)"}`,
        `Whisper STT:   ${r.whisperModelStt || "(auto-detect)"}`,
        `Whisper Wake:  ${r.whisperModelWake || "(auto-detect)"}`,
        "",
        `VAD Level:     ${current.vadAggressiveness} (0-3)`,
        `Master Vol:    ${current.masterVolume}`,
        `TTS Vol:       ${current.ttsVolume}`,
        "",
        "Sound Volumes:",
        `  ready:    ${current.volumes.ready}`,
        `  done:     ${current.volumes.done}`,
        `  thinking: ${current.volumes.thinking}`,
        `  listen:   ${current.volumes.listen}`,
        `  success:  ${current.volumes.success}`,
        `  error:    ${current.volumes.error}`,
        "",
        `Wake Word:     ${current.wakeWord}`,
        `Wake Enabled:  ${current.wakeEnabled}`,
        "",
        `Config file:   ${join(getExtensionDir(), "config.json")}`,
        `Extension dir: ${getExtensionDir()}`,
      ];

      if (ctx.hasUI) {
        const { Text } = await import("@mariozechner/pi-tui");
        ctx.ui.custom<void>((_tui, theme, _kb, done) => {
          const content = lines.map(l => theme.fg("dim", l)).join("\n");
          const comp = new Text(content, 0, 0);
          comp.onKey = (_key) => { done(); return true; };
          return comp;
        }, { overlay: true });
      } else {
        ctx.ui.notify(lines.join("\n"), "info");
      }
    },
  });

  // /voice - Quick voice switcher (edge-tts & espeak-ng profiles)
  pi.registerCommand("voice", {
    description: "Switch TTS voice. No args = list, /voice <name> = switch.",
    getArgumentCompletions: (prefix) => {
      const profiles = Object.keys(VOICE_PROFILES).map(p => ({
        value: p,
        label: `${p} - ${VOICE_PROFILES[p].label}`,
      }));
      const filtered = profiles.filter(p => p.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const requested = args?.trim().toLowerCase();

      if (!requested) {
        const current = cfg.profile;
        const available = Object.entries(VOICE_PROFILES)
          .map(([k, v]) => `  ${k}${k === current ? " ◀" : "  "} - ${v.label}`)
          .join("\n");
        ctx.ui.notify(`Voices:\n${available}\n\nUsage: /voice <name>`, "info");
        return;
      }

      if (!(requested in VOICE_PROFILES)) {
        ctx.ui.notify(`Unknown voice: "${requested}"`, "error");
        return;
      }

      cfg.profile = requested;
      saveConfig(cfg);
      const profile = VOICE_PROFILES[requested];
      await playSound("success", cfg.volumes.success, cfg.masterVolume);
      ctx.ui.notify(`Voice: ${profile.label} [${profile.engine}]`, "info");
    },
  });

  // /voice-profile - Switch voice profile
  pi.registerCommand("voice-profile", {
    description: "Switch voice profile (computer-en, computer-fr)",
    getArgumentCompletions: (prefix) => {
      const profiles = Object.keys(VOICE_PROFILES).map(p => ({
        value: p,
        label: `${p} - ${VOICE_PROFILES[p].label}`,
      }));
      const filtered = profiles.filter(p => p.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const profileName = args?.trim();
      if (!profileName || !(profileName in VOICE_PROFILES)) {
        const available = Object.entries(VOICE_PROFILES)
          .map(([k, v]) => `  ${k} - ${v.label}`)
          .join("\n");
        ctx.ui.notify(`Usage: /voice-profile <name>\n\nAvailable profiles:\n${available}`, "info");
        return;
      }
      const current = loadConfig();
      current.profile = profileName;
      saveConfig(current);
      const profile = VOICE_PROFILES[profileName];
      ctx.ui.notify(`Voice profile: ${profile.label}`, "info");
    },
  });

  // /wake-start - Start wake word daemon
  pi.registerCommand("wake-start", {
    description: "Start the wake word daemon",
    handler: async (_args, ctx) => {
      if (!resolved.whisperBin || !resolved.whisperModelWake) {
        ctx.ui.notify("Wake word requires whisper-cli and whisper model (tiny)", "error");
        return;
      }

      const wakeScript = join(getExtensionDir(), "wake_word.py");
      if (!existsSync(wakeScript)) {
        ctx.ui.notify("wake_word.py not found in extension directory", "error");
        return;
      }

      const cmd = `nohup python3 "${wakeScript}" --word "${cfg.wakeWord}" --whisper-bin "${resolved.whisperBin}" --whisper-model "${resolved.whisperModelWake}" > /dev/null 2>&1 & echo $!`;

      try {
        const { execSync } = await import("node:child_process");
        const pid = execSync(cmd, { timeout: 5000 }).toString().trim();
        ctx.ui.notify(`Wake word daemon started (PID: ${pid})`, "success");
      } catch (e: any) {
        ctx.ui.notify(`Failed to start wake word daemon: ${e.message}`, "error");
      }
    },
  });

  // /wake-stop - Stop wake word daemon
  pi.registerCommand("wake-stop", {
    description: "Stop the wake word daemon",
    handler: async (_args, ctx) => {
      const wakeScript = join(getExtensionDir(), "wake_word.py");
      try {
        const { execSync } = await import("node:child_process");
        const result = execSync(`python3 "${wakeScript}" --stop 2>&1`).toString().trim();
        ctx.ui.notify(result, "info");
      } catch (e: any) {
        ctx.ui.notify(`Failed to stop: ${e.message}`, "error");
      }
    },
  });

  // /wake-status - Check wake word daemon
  pi.registerCommand("wake-status", {
    description: "Check wake word daemon status",
    handler: async (_args, ctx) => {
      const statusFile = join(TASKS_DIR, "wake_word.status");
      const pidFile = join(homedir(), "tmp", "wake_word.pid");
      const logFile = join(homedir(), "tmp", "wake_word.log");

      let status = "Not running";
      try { status = (await readFileSync(statusFile, "utf-8")).trim(); } catch {}

      let pidInfo = "";
      try { pidInfo = `PID: ${(await readFileSync(pidFile, "utf-8")).trim()}`; } catch {
        pidInfo = "No PID file";
      }

      let lastLog = "";
      try {
        const logContent = (await readFileSync(logFile, "utf-8")).trim();
        const lines = logContent.split("\n");
        lastLog = lines.slice(-5).join("\n");
      } catch {}

      const msg = `Wake Word Daemon\nStatus: ${status}\n${pidInfo}\n\nRecent log:\n${lastLog || "(no logs)"}`;
      ctx.ui.notify(msg, "info");
    },
  });
}
