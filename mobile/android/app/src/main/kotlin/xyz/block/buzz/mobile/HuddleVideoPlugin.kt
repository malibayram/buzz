package xyz.block.buzz.mobile

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.view.Surface
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.view.TextureRegistry

internal class HuddleVideoPlugin(
    private val activity: Activity,
    messenger: BinaryMessenger,
    private val textures: TextureRegistry,
) : MethodChannel.MethodCallHandler, EventChannel.StreamHandler {
    private val channel = MethodChannel(messenger, "buzz/huddle_video")
    private var sink: EventChannel.EventSink? = null
    private var pending: MethodChannel.Result? = null
    private val capture = HuddleVideoCapture(activity, textures) { payload ->
        activity.runOnUiThread { sink?.success(payload) }
    }
    private val decoders = mutableMapOf<String, Decoder>()

    init {
        channel.setMethodCallHandler(this)
        EventChannel(messenger, "buzz/huddle_video/frames").setStreamHandler(this)
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
        sink = events
    }

    override fun onCancel(arguments: Any?) {
        sink = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "startCamera" -> startCamera(result)
            "stopCamera" -> {
                capture.stop()
                result.success(null)
            }
            "forceKeyframe" -> {
                capture.forceKeyframe()
                result.success(null)
            }
            "decode" -> result.success(decode(call))
            "release" -> {
                release(call.argument<Number>("textureId")?.toLong())
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    fun onRequestPermissionsResult(
        requestCode: Int,
        grantResults: IntArray,
    ): Boolean {
        if (requestCode != CAMERA_PERMISSION_REQUEST) return false
        val result = pending ?: return true
        pending = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            deliverStart(result)
        } else {
            result.error("permission", "Camera permission was denied.", null)
        }
        return true
    }

    fun dispose() {
        capture.stop()
        decoders.values.forEach { it.release() }
        decoders.clear()
        channel.setMethodCallHandler(null)
    }

    private fun deliverStart(result: MethodChannel.Result) {
        try {
            result.success(capture.start())
        } catch (error: Exception) {
            result.error("camera", error.message, null)
        }
    }

    private fun startCamera(result: MethodChannel.Result) {
        val granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            activity.checkSelfPermission(Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) {
            deliverStart(result)
            return
        }
        pending = result
        activity.requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_PERMISSION_REQUEST)
    }

    private fun decode(call: MethodCall): Long {
        val peer = call.argument<Int>("peer") ?: 0
        val epoch = call.argument<Int>("epoch") ?: 0
        val track = call.argument<Int>("track") ?: 0
        val annex = call.argument<ByteArray>("annexB") ?: ByteArray(0)
        val key = "$peer:$epoch:$track"
        val decoder = decoders.getOrPut(key) { Decoder(textures) }
        decoder.queue(annex, call.argument<Boolean>("keyframe") == true)
        return decoder.textureId
    }

    private fun release(textureId: Long?) {
        val key = decoders.entries.firstOrNull { it.value.textureId == textureId }?.key ?: return
        decoders.remove(key)?.release()
    }

    private class Decoder(textures: TextureRegistry) {
        private val entry = textures.createSurfaceTexture()
        val textureId = entry.id()
        private val codec = MediaCodec.createDecoderByType(MIME)
        private var started = false

        fun queue(annex: ByteArray, keyframe: Boolean) {
            if (!started && keyframe) {
                val format = MediaFormat.createVideoFormat(MIME, 640, 360)
                codec.configure(format, Surface(entry.surfaceTexture()), null, 0)
                codec.start()
                started = true
            }
            if (!started) return
            val index = codec.dequeueInputBuffer(0)
            if (index < 0) return
            val buffer = codec.getInputBuffer(index) ?: return
            buffer.clear()
            buffer.put(annex)
            val flags = if (keyframe) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
            codec.queueInputBuffer(index, 0, annex.size, System.nanoTime() / 1000, flags)
            val info = MediaCodec.BufferInfo()
            var output = codec.dequeueOutputBuffer(info, 0)
            while (output >= 0) {
                codec.releaseOutputBuffer(output, true)
                output = codec.dequeueOutputBuffer(info, 0)
            }
        }

        fun release() {
            if (started) codec.stop()
            codec.release()
            entry.release()
        }
    }

    companion object {
        private const val MIME = "video/avc"
        private const val CAMERA_PERMISSION_REQUEST = 7343
    }
}
