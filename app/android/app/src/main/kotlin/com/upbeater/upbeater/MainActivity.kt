package com.upbeater.upbeater

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.StatFs
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Upbeater の Android 側：PackageInstaller のセッションで導入する。
 * Android 12 以降、Upbeater がそのアプリの導入元であれば確認なしで更新できる（USER_ACTION_NOT_REQUIRED）。
 */
class MainActivity : FlutterActivity() {
    private val io = Executors.newSingleThreadExecutor()
    private val pending = HashMap<Int, MethodChannel.Result>()
    private val statusAction by lazy { "$packageName.INSTALL_STATUS" }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
            when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    // 初回など確認が要る場合は確認の画面を出す。最終の結果は後から届く
                    val confirm: Intent? = if (Build.VERSION.SDK_INT >= 33) {
                        intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                    } else {
                        @Suppress("DEPRECATION")
                        intent.getParcelableExtra(Intent.EXTRA_INTENT)
                    }
                    if (confirm != null) {
                        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        startActivity(confirm)
                    } else {
                        complete(sessionId, "failure", "確認の画面を開けません")
                    }
                }
                PackageInstaller.STATUS_SUCCESS -> complete(sessionId, "success", null)
                PackageInstaller.STATUS_FAILURE_ABORTED -> complete(sessionId, "aborted", "導入が取り消されました")
                else -> complete(
                    sessionId,
                    "failure",
                    intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "導入に失敗しました（状態 $status）",
                )
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val filter = IntentFilter(statusAction)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(receiver, filter)
        }
    }

    override fun onDestroy() {
        unregisterReceiver(receiver)
        io.shutdown()
        super.onDestroy()
    }

    private fun complete(sessionId: Int, status: String, message: String?) {
        val result = synchronized(pending) { pending.remove(sessionId) } ?: return
        runOnUiThread { result.success(mapOf("status" to status, "message" to message)) }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "upbeater/android").setMethodCallHandler { call, result ->
            when (call.method) {
                "canInstall" -> result.success(if (Build.VERSION.SDK_INT >= 26) packageManager.canRequestPackageInstalls() else true)
                "openInstallSettings" -> {
                    if (Build.VERSION.SDK_INT >= 26) {
                        startActivity(
                            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                    result.success(null)
                }
                "freeBytes" -> {
                    val path = call.argument<String>("path") ?: filesDir.path
                    result.success(StatFs(path).availableBytes)
                }
                "archiveInfo" -> background(result) { archiveInfo(call.argument<String>("path")!!) }
                "installedInfo" -> background(result) { installedInfo(call.argument<String>("package")!!) }
                "install" -> {
                    val path = call.argument<String>("path")!!
                    io.execute {
                        try {
                            install(File(path), result)
                        } catch (e: Exception) {
                            runOnUiThread { result.success(mapOf("status" to "failure", "message" to (e.message ?: e.javaClass.simpleName))) }
                        }
                    }
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun background(result: MethodChannel.Result, work: () -> Any?) {
        io.execute {
            try {
                val v = work()
                runOnUiThread { result.success(v) }
            } catch (e: Exception) {
                runOnUiThread { result.error("android_error", e.message, null) }
            }
        }
    }

    private fun describe(info: PackageInfo): Map<String, Any> {
        val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
        return mapOf("package" to info.packageName, "versionCode" to code, "signers" to signers(info))
    }

    /** 署名証明書の SHA-256（同じ署名鍵かを比べるため） */
    private fun signers(info: PackageInfo): List<String> {
        val sigs: Array<Signature>? = if (Build.VERSION.SDK_INT >= 28) {
            val s = info.signingInfo
            when {
                s == null -> null
                s.hasMultipleSigners() -> s.apkContentsSigners
                else -> s.signingCertificateHistory
            }
        } else {
            @Suppress("DEPRECATION")
            info.signatures
        }
        if (sigs == null) return emptyList()
        val md = MessageDigest.getInstance("SHA-256")
        return sigs.map { sig -> md.digest(sig.toByteArray()).joinToString("") { "%02x".format(it) } }
    }

    private fun signingFlag(): Int =
        if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES

    private fun archiveInfo(path: String): Map<String, Any>? {
        val info = if (Build.VERSION.SDK_INT >= 33) {
            packageManager.getPackageArchiveInfo(path, PackageManager.PackageInfoFlags.of(signingFlag().toLong()))
        } else {
            @Suppress("DEPRECATION")
            packageManager.getPackageArchiveInfo(path, signingFlag())
        } ?: return null
        return describe(info)
    }

    private fun installedInfo(pkg: String): Map<String, Any>? = try {
        val info = if (Build.VERSION.SDK_INT >= 33) {
            packageManager.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(signingFlag().toLong()))
        } else {
            @Suppress("DEPRECATION")
            packageManager.getPackageInfo(pkg, signingFlag())
        }
        describe(info)
    } catch (e: PackageManager.NameNotFoundException) {
        null
    }

    private fun install(file: File, result: MethodChannel.Result) {
        val installer = packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setSize(file.length())
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite("base.apk", 0, file.length()).use { out ->
                file.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            synchronized(pending) { pending[sessionId] = result }
            val intent = Intent(statusAction).setPackage(packageName)
            var flags = PendingIntent.FLAG_UPDATE_CURRENT
            if (Build.VERSION.SDK_INT >= 31) flags = flags or PendingIntent.FLAG_MUTABLE
            val sender = PendingIntent.getBroadcast(this, sessionId, intent, flags).intentSender
            session.commit(sender)
        }
    }
}
