package expo.modules.dialer

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.CallLog
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class DialerModule : Module() {
  private var callback: TelephonyCallback? = null

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
      context.startActivity(intent)
    }

    // shortcut: Android 12+ (API 31) only; add a PhoneStateListener fallback if a pilot phone runs Android 10–11.
    Function("startCallStateListener") {
      if (callback != null || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function null
      val cb = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
        override fun onCallStateChanged(state: Int) {
          val name = when (state) {
            TelephonyManager.CALL_STATE_OFFHOOK -> "OFFHOOK"
            TelephonyManager.CALL_STATE_RINGING -> "RINGING"
            else -> "IDLE"
          }
          sendEvent("onCallState", mapOf("state" to name))
        }
      }
      telephony.registerTelephonyCallback(context.mainExecutor, cb)
      callback = cb
    }

    Function("stopCallStateListener") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) callback?.let { telephony.unregisterTelephonyCallback(it) }
      callback = null
    }

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

    OnDestroy {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) callback?.let { telephony.unregisterTelephonyCallback(it) }
      callback = null
    }
  }
}
