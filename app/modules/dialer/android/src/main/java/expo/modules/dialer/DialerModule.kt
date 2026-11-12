package expo.modules.dialer

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.CallLog
import android.provider.Settings
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.SubscriptionManager
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

// OnePlus (ColorOS/OxygenOS) logs some calls with its own types: 100 outgoing, 101 incoming answered
// (seen on the Nord, 2026-11-10, alongside the standard 2 and 1).
private const val OPLUS_OUTGOING = 100
private const val OPLUS_INCOMING = 101

private val AUDIO = setOf("m4a", "mp3", "amr", "aac", "wav", "ogg", "3gp", "opus", "awb")
// The one normal folder Callyzer is pointed at (Callyzer → Settings → Change Call Recording Location).
private const val CALLYZER_FOLDER = "Recordings/Kalvium Calls"

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
    // simId: the subscription chosen in Preferences; null, or a SIM no longer in the phone, dials as the phone decides.
    Function("placeCall") { number: String, simId: Int? ->
      val intent = Intent(Intent.ACTION_CALL, Uri.fromParts("tel", number, null))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      simId?.let { phoneAccountFor(it) }?.let { intent.putExtra(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, it) }
      dialing = true
      sawOffhook = false
      context.startActivity(intent)
    }

    // The phone's active SIMs, for Preferences → Call from. No numbers: they need another permission and are often blank.
    Function("listSims") {
      val subs = context.getSystemService(SubscriptionManager::class.java)
      (subs.activeSubscriptionInfoList ?: emptyList()).map {
        mapOf("id" to it.subscriptionId, "slot" to it.simSlotIndex + 1, "name" to it.displayName?.toString().orEmpty(), "carrier" to it.carrierName?.toString().orEmpty())
      }
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
    AsyncFunction("lastOutgoingCall") { sinceMs: Double -> lastCall(intArrayOf(CallLog.Calls.OUTGOING_TYPE, OPLUS_OUTGOING), sinceMs) }

    // Newest incoming call since sinceMs that was picked up (missed and rejected calls have other types).
    AsyncFunction("lastIncomingCall") { sinceMs: Double -> lastCall(intArrayOf(CallLog.Calls.INCOMING_TYPE, OPLUS_INCOMING), sinceMs) }

    // JS brings the app back after an incoming call it recognises (a lead calling back).
    Function("bringToFront") { bringToFront() }

    // Recordings Callyzer can't find: phones save them in folders its picker can't reach (often hidden ones).
    // Android 11+ needs "All files access" to read those; Android 10 and older use the storage permission.
    Function("hasAllFilesAccess") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Environment.isExternalStorageManager()
      else context.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    }

    Function("openAllFilesAccessSettings") {
      context.startActivity(
        Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
    }

    // Audio files changed since sinceMs anywhere in shared storage, hidden folders included. Folder, time and size
    // only: file names hold phone numbers. Android/data and Android/obb are closed to every app, so they're skipped.
    AsyncFunction("findRecentAudio") { sinceMs: Double ->
      val root = Environment.getExternalStorageDirectory()
      val found = mutableListOf<File>()
      fun walk(dir: File, depth: Int) {
        if (depth > 8 || dir.relativeTo(root).path in setOf("Android/data", "Android/obb", CALLYZER_FOLDER)) return
        dir.listFiles()?.forEach { f ->
          if (f.isDirectory) walk(f, depth + 1)
          else if (f.extension.lowercase() in AUDIO && f.lastModified() >= sinceMs.toLong()) found += f
        }
      }
      walk(root, 0)
      found.sortedByDescending { it.lastModified() }.take(50).map {
        mapOf("folder" to it.parentFile!!.relativeTo(root).path, "modified" to it.lastModified().toDouble(), "size" to it.length().toDouble())
      }
    }

    // Copies new recordings from the phone's folder into CALLYZER_FOLDER, keeping the name and time so Callyzer
    // still matches each one to its call. A file written to in the last 3 s may still be recording: next time.
    AsyncFunction("copyNewRecordings") { folder: String, sinceMs: Double, done: List<String> ->
      val root = Environment.getExternalStorageDirectory()
      val target = File(root, CALLYZER_FOLDER).apply { mkdirs() }
      val now = System.currentTimeMillis()
      val copied = File(root, folder).listFiles().orEmpty().filter {
        it.isFile && it.extension.lowercase() in AUDIO && it.name !in done &&
          it.lastModified() >= sinceMs.toLong() && now - it.lastModified() > 3000
      }.mapNotNull { f ->
        try {
          val dest = f.copyTo(File(target, f.name), overwrite = true)
          dest.setLastModified(f.lastModified())
          dest
        } catch (e: Exception) {
          null // left out of the result, so it's tried again next time
        }
      }
      if (copied.isNotEmpty()) MediaScannerConnection.scanFile(context, copied.map { it.path }.toTypedArray(), null, null)
      copied.map { it.name }
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

  private fun lastCall(types: IntArray, sinceMs: Double): Map<String, Any>? =
    context.contentResolver.query(
      CallLog.Calls.CONTENT_URI,
      arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.DURATION, CallLog.Calls.DATE),
      "${CallLog.Calls.TYPE} IN (${types.joinToString { "?" }}) AND ${CallLog.Calls.DATE} >= ?",
      (types.map { it.toString() } + sinceMs.toLong().toString()).toTypedArray(),
      "${CallLog.Calls.DATE} DESC"
    )?.use { c ->
      if (!c.moveToFirst()) return null
      mapOf(
        "number" to (c.getString(0) ?: ""),
        "durationSec" to c.getLong(1),
        "date" to c.getLong(2).toDouble()
      )
    }

  private fun stopListening() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) callback?.let { telephony.unregisterTelephonyCallback(it) }
    @Suppress("DEPRECATION")
    legacyListener?.let { telephony.listen(it, PhoneStateListener.LISTEN_NONE) }
    callback = null
    legacyListener = null
  }

  private fun phoneAccountFor(subId: Int): PhoneAccountHandle? {
    val telecom = context.getSystemService(TelecomManager::class.java)
    return telecom.callCapablePhoneAccounts.firstOrNull { h ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) telephony.getSubscriptionId(h) == subId else h.id == subId.toString()
    }
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
