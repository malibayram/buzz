import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Raw binary invoke — uses Tauri's internal IPC for zero-copy ArrayBuffer transfer.
 *
 * The typed @tauri-apps/api doesn't support raw binary payloads (InvokeBody::Raw).
 * This wrapper isolates the internal API dependency to a single call site.
 * Tested against Tauri v2. If this breaks on upgrade, only this function needs updating.
 */
function invokeRawBinary(cmd: string, payload: Uint8Array): Promise<unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: Tauri internals have no public type definition
  const internals = (window as any).__TAURI_INTERNALS__;
  if (!internals?.invoke) {
    return Promise.reject(new Error("Tauri internals not available"));
  }
  return internals.invoke(cmd, payload);
}

/** Return type for setupAudioWorklet — stop + mode control. */
export type AudioWorkletHandle = {
  stop: () => void;
  /** Update whether the microphone is manually unmuted. */
  setTransmitting: (active: boolean) => void;
  /** Switch whether the push-to-talk shortcut participates in transmission. */
  setMode: (mode: "push_to_talk" | "voice_activity") => void;
  /** Set mic input gain (0–1). Adjusts the GainNode between source and worklet. */
  setGain: (value: number) => void;
};

/**
 * AudioWorklet → Rust STT pipeline:
 *
 *   MediaStreamTrack (mic, 48kHz)
 *     → AudioContext.createMediaStreamSource()
 *     → AudioWorkletNode("stt-tap-processor")
 *         worklet.js accumulates 100ms batches (4800 samples)
 *         posts Float32Array to main thread via port.postMessage
 *     → onmessage: convert to Uint8Array view (zero-copy)
 *     → invokeRawBinary("push_audio_pcm", bytes)
 *         Rust: SttPipeline::push_audio → bounded sync_channel
 *
 * Transmission gating:
 *   Main thread combines manual mute with Tauri "ptt-state" events from the
 *   global shortcut. The worklet sends audio while either path is open and
 *   discards frames only when both are closed.
 *
 * @param audioTrack - Mic track from getUserMedia
 * @param initialMode - Whether the push-to-talk shortcut is enabled.
 * @param initiallyManuallyUnmuted - Initial state of the clickable mic control.
 * @param onCaptureLost - The track ended or the context closed underneath us.
 */
export async function setupAudioWorklet(
  audioTrack: MediaStreamTrack,
  initialMode: "push_to_talk" | "voice_activity" = "voice_activity",
  initiallyManuallyUnmuted = true,
  onCaptureLost: () => void = () => undefined,
): Promise<AudioWorkletHandle> {
  const audioContext = new AudioContext({ sampleRate: 48000 });
  let stopping = false;

  // Resume after user gesture (required by autoplay policy)
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  // The OS or WebKit can interrupt capture underneath us (another page
  // starting a camera, a device unplugged, an audio-session interruption).
  // Log every transition so it shows up in reports, resume an interrupted
  // context, and hand a dead track back to the owner to re-acquire.
  const onContextState = () => {
    const state = audioContext.state as AudioContextState | "interrupted";
    if (stopping) return;
    console.warn(`[huddle-audio] AudioContext ${state}`);
    if (state === "suspended" || state === "interrupted") {
      void audioContext.resume().catch(() => undefined);
    }
    if (state === "closed") onCaptureLost();
  };
  const onTrackMute = () => console.warn("[huddle-audio] mic track muted");
  const onTrackUnmute = () => console.warn("[huddle-audio] mic track unmuted");
  const onTrackEnded = () => {
    if (stopping) return;
    console.warn("[huddle-audio] mic track ended");
    onCaptureLost();
  };
  audioContext.addEventListener("statechange", onContextState);
  audioTrack.addEventListener("mute", onTrackMute);
  audioTrack.addEventListener("unmute", onTrackUnmute);
  audioTrack.addEventListener("ended", onTrackEnded);

  // Load the worklet processor (must live in public/ for Vite to serve it)
  await audioContext.audioWorklet.addModule("/worklet.js");

  const source = audioContext.createMediaStreamSource(
    new MediaStream([audioTrack]),
  );

  const gainNode = audioContext.createGain();

  const workletNode = new AudioWorkletNode(audioContext, "stt-tap-processor");

  // Connect: mic → gain → worklet (tap only — no playback)
  source.connect(gainNode);
  gainNode.connect(workletNode);

  let currentMode = initialMode;
  let shortcutActive = false;
  let manuallyUnmuted = initiallyManuallyUnmuted;
  const syncTransmission = () => {
    workletNode.port.postMessage({
      type: "ptt",
      active:
        manuallyUnmuted || (currentMode === "push_to_talk" && shortcutActive),
    });
  };
  syncTransmission();

  // Forward PCM batches to Rust via raw binary invoke.
  // Direction: worklet→main (receives PCM data from worklet processor).
  workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const float32 = event.data;
    // Fire-and-forget — Rust side uses try_send which drops on backpressure.
    // No await: prevents main-thread backpressure from slow Rust processing.
    // Create a zero-copy Uint8Array view over the same underlying buffer.
    // Rust reinterprets the bytes as f32 on the other side.
    invokeRawBinary(
      "push_audio_pcm",
      new Uint8Array(float32.buffer, float32.byteOffset, float32.byteLength),
    ).catch(() => {
      /* silently drop — Rust handles backpressure */
    });
  };

  // Listen for PTT state from Rust global shortcut (Ctrl+Space press/release).
  // Direction: Rust→main→worklet. The Tauri event carries a boolean payload.
  let pttUnlisten: UnlistenFn | null = null;
  try {
    pttUnlisten = await listen<boolean>("ptt-state", (event) => {
      // Only forward PTT events to the worklet when in PTT mode.
      // Manual unmute remains independent from the shortcut state.
      if (currentMode === "push_to_talk") {
        shortcutActive = event.payload;
        syncTransmission();
      }
    });
  } catch {
    // PTT events not available — worklet stays in current transmit mode.
    // This is fine for VAD mode (always transmitting) and degrades gracefully
    // for PTT mode (user won't be able to transmit, but audio won't leak).
  }

  return {
    stop: () => {
      stopping = true;
      audioContext.removeEventListener("statechange", onContextState);
      audioTrack.removeEventListener("mute", onTrackMute);
      audioTrack.removeEventListener("unmute", onTrackUnmute);
      audioTrack.removeEventListener("ended", onTrackEnded);
      workletNode.port.onmessage = null;
      pttUnlisten?.();
      source.disconnect();
      gainNode.disconnect();
      workletNode.disconnect();
      void audioContext.close();
    },
    setTransmitting: (active: boolean) => {
      manuallyUnmuted = active;
      syncTransmission();
    },
    setMode: (mode: "push_to_talk" | "voice_activity") => {
      currentMode = mode;
      shortcutActive = false;
      syncTransmission();
    },
    setGain: (value: number) => {
      gainNode.gain.value = value;
    },
  };
}
