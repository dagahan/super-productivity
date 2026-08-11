package com.superproductivity.superproductivity.plugins

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.superproductivity.superproductivity.service.BluetoothSyncNotificationHelper
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

private const val SHARED_STORE_DIR_NAME = "bluetooth-sync"
private const val STREAM_CHUNK_BYTES = 65536
private const val BLUETOOTH_PERMISSIONS_ALIAS = "bluetooth"

val SYNC_SERVICE_UUID: UUID =
    UUID.fromString("7a9c1e40-5b3d-4f21-9c86-2e1d0a7b4f33")

@SuppressLint("MissingPermission")
@CapacitorPlugin(
    name = "BluetoothSyncBridge",
    permissions = [
        Permission(
            alias = BLUETOOTH_PERMISSIONS_ALIAS,
            strings = [
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
            ]
        )
    ]
)
class BluetoothSyncPlugin : Plugin() {

    private val linksById = ConcurrentHashMap<String, PeerLink>()
    private val nextLinkSequence = AtomicInteger(0)
    private val linkExecutor = Executors.newCachedThreadPool()
    private var serverSocket: BluetoothServerSocket? = null
    private var isListening = false
    private val psmExchange by lazy { BluetoothPsmExchange(context) }

    private inner class PeerLink(
        val linkId: String,
        private val socket: BluetoothSocket,
    ) {
        private val writeExecutor = Executors.newSingleThreadExecutor()

        @Volatile
        private var isClosed = false

        fun startReading() {
            linkExecutor.execute {
                val buffer = ByteArray(STREAM_CHUNK_BYTES)
                try {
                    while (!isClosed) {
                        val read = socket.inputStream.read(buffer)
                        if (read <= 0) break
                        notifyListeners(
                            "linkData",
                            JSObject()
                                .put("linkId", linkId)
                                .put(
                                    "dataBase64",
                                    Base64.encodeToString(
                                        buffer.copyOf(read), Base64.NO_WRAP
                                    )
                                )
                        )
                    }
                    close("peer closed the channel")
                } catch (e: IOException) {
                    close(e.message ?: "link read failed")
                }
            }
        }

        fun write(payload: ByteArray, call: PluginCall) {
            writeExecutor.execute {
                try {
                    socket.outputStream.write(payload)
                    socket.outputStream.flush()
                    call.resolve()
                } catch (e: IOException) {
                    close(e.message ?: "link write failed")
                    call.reject(e.message ?: "link write failed")
                }
            }
        }

        fun close(reason: String) {
            if (isClosed) return
            isClosed = true
            writeExecutor.shutdown()
            try {
                socket.close()
            } catch (_: IOException) {
            }
            linksById.remove(linkId)
            notifyListeners(
                "linkClosed",
                JSObject().put("linkId", linkId).put("reason", reason)
            )
        }
    }

    private fun bluetoothAdapter(): BluetoothAdapter? =
        context.getSystemService(BluetoothManager::class.java)?.adapter

    private fun hasBluetoothPermissions(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) ==
            PackageManager.PERMISSION_GRANTED

    private fun sharedStoreDir(): File =
        File(context.filesDir, SHARED_STORE_DIR_NAME).apply { mkdirs() }

    private fun resolveInsideSharedStore(relativePath: String): File {
        val root = sharedStoreDir().canonicalFile
        val target = File(root, relativePath).canonicalFile
        if (target != root && !target.path.startsWith(root.path + File.separator)) {
            throw IOException("Bluetooth shared file path escapes the shared store")
        }
        return target
    }

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val adapter = bluetoothAdapter()
        val isSupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        call.resolve(
            JSObject().put(
                "isAvailable",
                isSupported && adapter?.isEnabled == true && hasBluetoothPermissions()
            )
        )
    }

    @PluginMethod
    fun showSyncProgress(call: PluginCall) {
        BluetoothSyncNotificationHelper.showProgress(context)
        call.resolve()
    }

    @PluginMethod
    fun hideSyncProgress(call: PluginCall) {
        BluetoothSyncNotificationHelper.hideProgress(context)
        call.resolve()
    }

    @PluginMethod
    fun showSyncFailure(call: PluginCall) {
        val reason = call.getString("reason")
        BluetoothSyncNotificationHelper.showFailure(
            context,
            if (reason.isNullOrBlank()) "Your devices could not finish syncing." else reason,
        )
        call.resolve()
    }

    @PluginMethod
    fun getLocalDeviceName(call: PluginCall) {
        call.resolve(
            JSObject().put("deviceName", bluetoothAdapter()?.name ?: Build.MODEL)
        )
    }

    @PluginMethod
    fun listPairedDevices(call: PluginCall) {
        if (!hasBluetoothPermissions()) {
            requestPermissionForAlias(BLUETOOTH_PERMISSIONS_ALIAS, call, "onBluetoothPermission")
            return
        }
        val adapter = bluetoothAdapter()
        if (adapter == null) {
            call.reject("This device has no Bluetooth adapter")
            return
        }
        val devices = JSArray()
        for (device in adapter.bondedDevices.orEmpty()) {
            devices.put(
                JSObject()
                    .put("platformAddress", device.address)
                    .put("deviceName", device.name ?: device.address)
                    .put("isCurrentlyConnected", false)
            )
        }
        call.resolve(JSObject().put("devices", devices))
    }

    @PermissionCallback
    private fun onBluetoothPermission(call: PluginCall) {
        if (!hasBluetoothPermissions()) {
            call.reject("Bluetooth permission was not granted")
            return
        }
        when (call.methodName) {
            "listPairedDevices" -> listPairedDevices(call)
            "connectToDevice" -> connectToDevice(call)
            "startListening" -> startListening(call)
            else -> call.resolve()
        }
    }

    @PluginMethod
    fun connectToDevice(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Bluetooth sync needs Android 10 or newer")
            return
        }
        if (!hasBluetoothPermissions()) {
            requestPermissionForAlias(BLUETOOTH_PERMISSIONS_ALIAS, call, "onBluetoothPermission")
            return
        }
        val platformAddress = call.getString("platformAddress")
        if (platformAddress.isNullOrBlank()) {
            call.reject("platformAddress is required")
            return
        }
        val adapter = bluetoothAdapter()
        if (adapter == null) {
            call.reject("This device has no Bluetooth adapter")
            return
        }

        val device = try {
            adapter.getRemoteDevice(platformAddress)
        } catch (e: IllegalArgumentException) {
            call.reject("$platformAddress is not an address this device can dial")
            return
        }
        call.setKeepAlive(true)
        psmExchange.readPeerPsm(
            device,
            onResolved = { psm -> openL2capChannel(device, psm, call) },
            onFailed = { reason -> call.reject(reason) },
        )
    }

    private fun openL2capChannel(device: BluetoothDevice, psm: Int, call: PluginCall) {
        linkExecutor.execute {
            try {
                val socket = device.createInsecureL2capChannel(psm)
                socket.connect()
                val link = registerLink(socket)
                link.startReading()
                call.resolve(JSObject().put("linkId", link.linkId))
            } catch (e: Exception) {
                call.reject(
                    "Could not open the sync channel (${e.message ?: "unknown failure"}). " +
                        "Forget this device in Bluetooth settings and pair it again."
                )
            }
        }
    }

    @PluginMethod
    fun startListening(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Bluetooth sync needs Android 10 or newer")
            return
        }
        if (!hasBluetoothPermissions()) {
            requestPermissionForAlias(BLUETOOTH_PERMISSIONS_ALIAS, call, "onBluetoothPermission")
            return
        }
        if (isListening) {
            call.resolve()
            return
        }
        val adapter = bluetoothAdapter()
        if (adapter == null) {
            call.reject("This device has no Bluetooth adapter")
            return
        }

        try {
            val listener = adapter.listenUsingInsecureL2capChannel()
            serverSocket = listener
            isListening = true
            psmExchange.publishLocalPsm(listener.psm)
            linkExecutor.execute { acceptIncomingLinks(listener) }
            call.resolve(JSObject().put("psm", listener.psm))
        } catch (e: IOException) {
            call.reject(e.message ?: "Could not publish an L2CAP channel")
        }
    }

    private fun acceptIncomingLinks(listener: BluetoothServerSocket) {
        while (isListening) {
            try {
                val socket = listener.accept()
                val link = registerLink(socket)
                notifyListeners(
                    "incomingLink",
                    JSObject()
                        .put("linkId", link.linkId)
                        .put("peerDeviceId", socket.remoteDevice?.address ?: "")
                )
                link.startReading()
            } catch (e: IOException) {
                if (isListening) {
                    isListening = false
                }
                return
            }
        }
    }

    private fun registerLink(socket: BluetoothSocket): PeerLink {
        val linkId = "link-${nextLinkSequence.incrementAndGet()}"
        val link = PeerLink(linkId, socket)
        linksById[linkId] = link
        return link
    }

    @PluginMethod
    fun stopListening(call: PluginCall) {
        isListening = false
        psmExchange.stopPublishing()
        try {
            serverSocket?.close()
        } catch (_: IOException) {
        }
        serverSocket = null
        call.resolve()
    }

    @PluginMethod
    fun write(call: PluginCall) {
        val linkId = call.getString("linkId")
        val dataBase64 = call.getString("dataBase64")
        if (linkId == null || dataBase64 == null) {
            call.reject("linkId and dataBase64 are required")
            return
        }
        val link = linksById[linkId]
        if (link == null) {
            call.reject("Unknown link $linkId")
            return
        }
        call.setKeepAlive(true)
        link.write(Base64.decode(dataBase64, Base64.NO_WRAP), call)
    }

    @PluginMethod
    fun closeLink(call: PluginCall) {
        val linkId = call.getString("linkId")
        if (linkId == null) {
            call.reject("linkId is required")
            return
        }
        linksById[linkId]?.close("closed locally")
        call.resolve()
    }

    @PluginMethod
    fun readSharedFile(call: PluginCall) {
        val filePath = call.getString("filePath")
        if (filePath == null) {
            call.reject("filePath is required")
            return
        }
        val file = resolveInsideSharedStore(filePath)
        if (!file.isFile) {
            call.resolve(JSObject().put("dataStr", null))
            return
        }
        try {
            call.resolve(JSObject().put("dataStr", file.readText()))
        } catch (e: IOException) {
            call.reject(e.message ?: "Could not read the shared file")
        }
    }

    @PluginMethod
    fun writeSharedFile(call: PluginCall) {
        val filePath = call.getString("filePath")
        val dataStr = call.getString("dataStr")
        if (filePath == null || dataStr == null) {
            call.reject("filePath and dataStr are required")
            return
        }
        try {
            val target = resolveInsideSharedStore(filePath)
            target.parentFile?.mkdirs()
            val temporary = File(target.parentFile, "${target.name}.tmp")
            temporary.writeText(dataStr)
            if (!temporary.renameTo(target)) {
                throw IOException("Could not commit the shared file")
            }
            call.resolve()
        } catch (e: IOException) {
            call.reject(e.message ?: "Could not write the shared file")
        }
    }

    @PluginMethod
    fun deleteSharedFile(call: PluginCall) {
        val filePath = call.getString("filePath")
        if (filePath == null) {
            call.reject("filePath is required")
            return
        }
        try {
            resolveInsideSharedStore(filePath).delete()
            call.resolve()
        } catch (e: IOException) {
            call.reject(e.message ?: "Could not delete the shared file")
        }
    }

    @PluginMethod
    fun listSharedFiles(call: PluginCall) {
        val dirPath = call.getString("dirPath") ?: ""
        try {
            val filePaths = JSArray()
            resolveInsideSharedStore(dirPath).listFiles()?.forEach { filePaths.put(it.name) }
            call.resolve(JSObject().put("filePaths", filePaths))
        } catch (e: IOException) {
            call.reject(e.message ?: "Could not list the shared files")
        }
    }
}
