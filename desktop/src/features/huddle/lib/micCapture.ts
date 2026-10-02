import { type AudioWorkletHandle, setupAudioWorklet } from "./audioWorklet";

export type MicCapture = {
  stream: MediaStream;
  track: MediaStreamTrack;
  worklet: AudioWorkletHandle;
  deviceId: string;
};

type MicOptions = {
  deviceId: string;
  mode: "push_to_talk" | "voice_activity";
  /** Manual mute state the worklet starts with. */
  unmuted: boolean;
  /** Track enabled state (false while locally muted). */
  enabled: boolean;
  gain: number;
  onLost: () => void;
};

/**
 * Speech capture constraints. 48 kHz mono matches the Opus encoder and the
 * worklet's 960-sample frames; AEC/NS/AGC stay on for open-speaker calls.
 */
export function micConstraints(deviceId: string): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: 48000,
  };
  if (deviceId) constraints.deviceId = { exact: deviceId };
  return constraints;
}

/** Open the mic and its PCM worklet; the stream is stopped on any failure. */
export async function acquireMic({
  deviceId,
  mode,
  unmuted,
  enabled,
  gain,
  onLost,
}: MicOptions): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: micConstraints(deviceId),
  });
  try {
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error("No microphone track");
    track.enabled = enabled;
    const worklet = await setupAudioWorklet(track, mode, unmuted, onLost);
    worklet.setGain(gain);
    return { stream, track, worklet, deviceId };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    throw error;
  }
}

/** Bluetooth headset mics switch the headset to narrowband (HFP) audio. */
export function looksLikeHeadsetMic(label: string): boolean {
  return /airpods|bluetooth|hands-?free|headset|buds|beats|bose|sony wh|jabra/i.test(
    label,
  );
}
