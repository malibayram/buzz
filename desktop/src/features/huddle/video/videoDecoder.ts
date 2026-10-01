import { CODEC } from "./protocol";

export type TileDecoder = {
  push: (keyframe: boolean, timestamp: number, data: Uint8Array) => void;
  close: () => void;
};

export function openTileDecoder(canvas: HTMLCanvasElement): TileDecoder {
  const context = canvas.getContext("2d");
  let decoder: VideoDecoder | null = null;
  const ensure = () => {
    if (decoder || typeof VideoDecoder === "undefined") return decoder;
    decoder = new VideoDecoder({
      output: (frame) => {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
        context?.drawImage(frame, 0, 0);
        frame.close();
      },
      error: () => undefined,
    });
    decoder.configure({
      codec: CODEC,
      optimizeForLatency: true,
      avc: { format: "annexb" },
    } as VideoDecoderConfig);
    return decoder;
  };
  return {
    push(keyframe, timestamp, data) {
      const current = ensure();
      if (current == null) return;
      if (current.state !== "configured") return;
      current.decode(
        new EncodedVideoChunk({
          type: keyframe ? "key" : "delta",
          timestamp,
          data,
        }),
      );
    },
    close() {
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = null;
    },
  };
}
