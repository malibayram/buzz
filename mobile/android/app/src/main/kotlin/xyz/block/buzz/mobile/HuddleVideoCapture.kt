package xyz.block.buzz.mobile

import android.annotation.SuppressLint
import android.app.Activity
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import io.flutter.view.TextureRegistry

internal class HuddleVideoCapture(
    private val activity: Activity,
    private val textures: TextureRegistry,
    private val onEncoded: (Map<String, Any>) -> Unit,
) {
    private var cameraThread: HandlerThread? = null
    private var drainThread: Thread? = null
    private var camera: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var encoder: MediaCodec? = null
    private var preview: TextureRegistry.SurfaceTextureEntry? = null
    private var running = false
    private var timestamp90k = 0

    fun start(): Long {
        stop()
        running = true
        val cameraThread = HandlerThread("buzz-huddle-video").also { it.start() }
        this.cameraThread = cameraThread
        val handler = Handler(cameraThread.looper)
        val entry = textures.createSurfaceTexture()
        preview = entry
        entry.surfaceTexture().setDefaultBufferSize(WIDTH, HEIGHT)
        val encoder = MediaCodec.createEncoderByType(MIME)
        val format = MediaFormat.createVideoFormat(MIME, WIDTH, HEIGHT).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, 600_000)
            setInteger(MediaFormat.KEY_FRAME_RATE, 24)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
            setInteger(MediaFormat.KEY_PREPEND_HEADER_TO_SYNC_FRAMES, 1)
        }
        encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val input = encoder.createInputSurface()
        encoder.start()
        this.encoder = encoder
        openCamera(Surface(entry.surfaceTexture()), input, handler)
        drainThread = Thread({ drain(encoder) }, "buzz-huddle-video-drain").also { it.start() }
        return entry.id()
    }

    fun stop() {
        running = false
        drainThread?.join(200)
        drainThread = null
        session?.close()
        camera?.close()
        runCatching { encoder?.stop() }
        encoder?.release()
        preview?.release()
        cameraThread?.quitSafely()
        session = null
        camera = null
        encoder = null
        preview = null
        cameraThread = null
    }

    fun forceKeyframe() {
        encoder?.setParameters(Bundle().apply {
            putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
        })
    }

    @SuppressLint("MissingPermission")
    private fun openCamera(previewSurface: Surface, encoderSurface: Surface, handler: Handler) {
        val manager = activity.getSystemService(Activity.CAMERA_SERVICE) as CameraManager
        val id = manager.cameraIdList.firstOrNull() ?: return
        manager.openCamera(id, object : CameraDevice.StateCallback() {
            override fun onOpened(device: CameraDevice) {
                camera = device
                device.createCaptureSession(
                    listOf(previewSurface, encoderSurface),
                    object : CameraCaptureSession.StateCallback() {
                        override fun onConfigured(capture: CameraCaptureSession) {
                            session = capture
                            val request = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
                                addTarget(previewSurface)
                                addTarget(encoderSurface)
                            }
                            capture.setRepeatingRequest(request.build(), null, handler)
                        }

                        override fun onConfigureFailed(capture: CameraCaptureSession) = Unit
                    },
                    handler,
                )
            }

            override fun onDisconnected(device: CameraDevice) = device.close()
            override fun onError(device: CameraDevice, error: Int) = device.close()
        }, handler)
    }

    private fun drain(encoder: MediaCodec) {
        val info = MediaCodec.BufferInfo()
        while (running) {
            val index = encoder.dequeueOutputBuffer(info, 10_000)
            if (index < 0) continue
            val buffer = encoder.getOutputBuffer(index)
            if (buffer != null && info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                val bytes = ByteArray(info.size)
                buffer.position(info.offset)
                buffer.get(bytes)
                timestamp90k += 3750
                val keyframe = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                activity.runOnUiThread {
                    onEncoded(mapOf("annexB" to bytes, "keyframe" to keyframe, "ts90k" to timestamp90k))
                }
            }
            encoder.releaseOutputBuffer(index, false)
        }
    }

    companion object {
        private const val MIME = "video/avc"
        private const val WIDTH = 640
        private const val HEIGHT = 360
    }
}
