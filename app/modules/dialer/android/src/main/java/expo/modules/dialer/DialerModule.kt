package expo.modules.dialer

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.CallLog
import android.provider.Settings
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class DialerModule : Module() {
  private var callback: TelephonyCallback? = null // Android 12+
  private var legacyListener: PhoneStateListener? = null // Android 10–11
  private var dialing = false // a call we placed is in progress
  private var sawOffhook = false

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val telephony: TelephonyManager
    get() = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager

  override fun definition() = ModuleDefinition {
    Name("Dialer")

    Events("onCallState")

    // Goes through the system phone app, so the phone's auto-record and Callyzer see the call.
    Function("placeCall") { number: String ->
      val intent = Intent(Intent.ACTION_CALL, Uri.fromParts("tel", number, null))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      dialing = true
      sawOffhook = false
      context.startActivity(intent)
    }

    // Android only lets a background app return to the front with "Display over other apps".
    Function("canBringToFront") { Settings.canDrawOverlays(context) }

    Function("openBringToFrontSettings") {
      context.startActivity(
        Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
    }

    // Android 12+ uses TelephonyCallback; Android 10–11 the older PhoneStateListener (same states).
    Function("startCallStateListener") {
      if (callback != null || legacyListener != null) return@Function null
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val cb = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
          override fun onCallStateChanged(state: Int) = onCallState(state)
        }
        telephony.registerTelephonyCallback(context.mainExecutor, cb)
        callback = cb
      } else {
        // PhoneStateListener needs a Looper thread, so it's created and registered on the main thread.
        Handler(Looper.getMainLooper()).post {
          @Suppress("DEPRECATION")
          val l = object : PhoneStateListener() {
            @Deprecated("Android 10–11 only")
            override fun onCallStateChanged(state: Int, phoneNumber: String?) = onCallState(state)
          }
          @Suppress("DEPRECATION")
          telephony.listen(l, PhoneStateListener.LISTEN_CALL_STATE)
          legacyListener = l
        }
      }
      null
    }

    Function("stopCallStateListener") { stopListening() }

    // Foreground service + wake lock while dialing (KeepAliveService); stop it when the loop stops.
    Function("startKeepAlive") { context.startForegroundService(Intent(context, KeepAliveService::class.java)); Unit }
    Function("stopKeepAlive") { context.stopService(Intent(context, KeepAliveService::class.java)); Unit }

    // Newest outgoing call since sinceMs. Talk time > 0 means the other side answered.
    AsyncFunction("lastOutgoingCall") { sinceMs: Double ->
      context.contentResolver.query(
        CallLog.Calls.CONTENT_URI,
        arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.DURATION, CallLog.Calls.DATE),
        "${CallLog.Calls.TYPE} = ? AND ${CallLog.Calls.DATE} >= ?",
        arrayOf(CallLog.Calls.OUTGOING_TYPE.toString(), sinceMs.toLong().toString()),
        "${CallLog.Calls.DATE} DESC"
      )?.use { c ->
        if (!c.moveToFirst()) return@AsyncFunction null
        mapOf(
          "number" to c.getString(0),
          "durationSec" to c.getLong(1),
          "date" to c.getLong(2).toDouble()
        )
      }
    }

    OnDestroy { stopListening() }
  }

  private fun onCallState(state: Int) {
    val name = when (state) {
      TelephonyManager.CALL_STATE_OFFHOOK -> "OFFHOOK"
      TelephonyManager.CALL_STATE_RINGING -> "RINGING"
      else -> "IDLE"
    }
    if (dialing && name == "OFFHOOK") sawOffhook = true
    // Done natively: React Native pauses JS timers while the phone app is on top,
    // and some phone apps (OnePlus) stay on screen when the caller hangs up.
    if (dialing && sawOffhook && name == "IDLE") {
      dialing = false
      bringToFront()
    }
    sendEvent("onCallState", mapOf("state" to name))
  }

  private fun stopListening() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) callback?.let { telephony.unregisterTelephonyCallback(it) }
    @Suppress("DEPRECATION")
    legacyListener?.let { telephony.listen(it, PhoneStateListener.LISTEN_NONE) }
    callback = null
    legacyListener = null
  }

  private fun bringToFront() {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
    try {
      context.startActivity(launch)
    } catch (e: Exception) {
      // Blocked without the overlay permission; the app catches up when the user opens it.
    }
  }
}
