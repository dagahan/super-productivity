package com.superproductivity.superproductivity.plugins

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import java.util.UUID

val PSM_CHARACTERISTIC_UUID: UUID =
    UUID.fromString("7a9c1e44-5b3d-4f21-9c86-2e1d0a7b4f33")

private const val PSM_READ_TIMEOUT_MS = 25_000L
private const val PSM_LOG_TAG = "SPBluetoothSync"

@SuppressLint("MissingPermission")
class BluetoothPsmExchange(private val context: Context) {

    private val mainHandler = Handler(Looper.getMainLooper())
    private var gattServer: BluetoothGattServer? = null
    private var advertiseCallback: AdvertiseCallback? = null

    fun publishLocalPsm(psm: Int) {
        val manager = context.getSystemService(BluetoothManager::class.java) ?: return
        stopPublishing()

        val psmCharacteristic = BluetoothGattCharacteristic(
            PSM_CHARACTERISTIC_UUID,
            BluetoothGattCharacteristic.PROPERTY_READ,
            BluetoothGattCharacteristic.PERMISSION_READ,
        )
        val service = BluetoothGattService(
            SYNC_SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY
        )
        service.addCharacteristic(psmCharacteristic)

        val psmBytes = byteArrayOf((psm and 0xFF).toByte(), ((psm shr 8) and 0xFF).toByte())
        val server = manager.openGattServer(
            context,
            object : BluetoothGattServerCallback() {
                override fun onCharacteristicReadRequest(
                    device: BluetoothDevice,
                    requestId: Int,
                    offset: Int,
                    characteristic: BluetoothGattCharacteristic,
                ) {
                    val value =
                        if (characteristic.uuid == PSM_CHARACTERISTIC_UUID) psmBytes
                        else ByteArray(0)
                    gattServer?.sendResponse(
                        device, requestId, BluetoothGatt.GATT_SUCCESS, offset,
                        value.copyOfRange(minOf(offset, value.size), value.size)
                    )
                }
            },
        ) ?: return

        gattServer = server
        server.addService(service)
        startAdvertising()
    }

    fun stopPublishing() {
        advertiseCallback?.let {
            context.getSystemService(BluetoothManager::class.java)
                ?.adapter?.bluetoothLeAdvertiser?.stopAdvertising(it)
        }
        advertiseCallback = null
        gattServer?.close()
        gattServer = null
    }

    private fun startAdvertising() {
        val advertiser = context.getSystemService(BluetoothManager::class.java)
            ?.adapter?.bluetoothLeAdvertiser ?: return
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
            .setConnectable(true)
            .setTimeout(0)
            .build()
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(ParcelUuid(SYNC_SERVICE_UUID))
            .build()
        val scanResponse = AdvertiseData.Builder()
            .setIncludeDeviceName(true)
            .build()
        val callback = object : AdvertiseCallback() {
            override fun onStartFailure(errorCode: Int) {
                Log.i(PSM_LOG_TAG, "Advertising the sync service failed with code $errorCode")
            }
        }
        advertiseCallback = callback
        advertiser.startAdvertising(settings, data, scanResponse, callback)
    }

    fun readPeerPsm(
        device: BluetoothDevice,
        onResolved: (Int) -> Unit,
        onFailed: (String) -> Unit,
    ) {
        var hasSettled = false
        var openGatt: BluetoothGatt? = null
        var hasRefreshedCache = false
        var hasWaitedForPeer = false
        var waitForPeerToComeBack: (() -> Boolean)? = null

        val settle = { psm: Int?, failure: String? ->
            if (!hasSettled) {
                hasSettled = true
                openGatt?.disconnect()
                openGatt?.close()
                if (psm != null) onResolved(psm) else onFailed(failure ?: "unknown failure")
            }
        }

        val timeout = Runnable { settle(null, "timed out reading the peer PSM") }
        mainHandler.postDelayed(timeout, PSM_READ_TIMEOUT_MS)

        val callback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    gatt.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    if (waitForPeerToComeBack?.invoke() == true) {
                        return
                    }
                    mainHandler.removeCallbacks(timeout)
                    settle(null, "peer disconnected before returning a PSM")
                }
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                val characteristic = gatt.getService(SYNC_SERVICE_UUID)
                    ?.getCharacteristic(PSM_CHARACTERISTIC_UUID)
                if (characteristic == null) {
                    if (rediscoverWithFreshAttributes(gatt)) {
                        return
                    }
                    mainHandler.removeCallbacks(timeout)
                    settle(null, "peer does not expose the sync PSM characteristic")
                    return
                }
                gatt.readCharacteristic(characteristic)
            }

            @Suppress("DEPRECATION")
            override fun onCharacteristicRead(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                status: Int,
            ) = acceptPsm(gatt, characteristic.value, status)

            override fun onCharacteristicRead(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                value: ByteArray,
                status: Int,
            ) = acceptPsm(gatt, value, status)

            private fun acceptPsm(gatt: BluetoothGatt, value: ByteArray?, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS && value != null && value.size >= 2) {
                    mainHandler.removeCallbacks(timeout)
                    val psm = (value[0].toInt() and 0xFF) or ((value[1].toInt() and 0xFF) shl 8)
                    settle(psm, null)
                    return
                }
                Log.i(PSM_LOG_TAG, "PSM read failed status=$status bytes=${value?.size ?: -1}")
                if (rediscoverWithFreshAttributes(gatt)) {
                    return
                }
                mainHandler.removeCallbacks(timeout)
                settle(
                    null,
                    "peer returned no usable PSM (status=$status bytes=${value?.size ?: -1})",
                )
            }

            private fun rediscoverWithFreshAttributes(gatt: BluetoothGatt): Boolean {
                if (hasRefreshedCache) {
                    return false
                }
                hasRefreshedCache = true
                refreshGattCache(gatt)
                mainHandler.postDelayed({ gatt.discoverServices() }, 600)
                return true
            }
        }

        waitForPeerToComeBack = {
            if (hasSettled || hasWaitedForPeer) {
                false
            } else {
                hasWaitedForPeer = true
                openGatt?.close()
                openGatt =
                    device.connectGatt(context, true, callback, BluetoothDevice.TRANSPORT_LE)
                openGatt != null
            }
        }

        openGatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
        if (openGatt == null && waitForPeerToComeBack?.invoke() != true) {
            mainHandler.removeCallbacks(timeout)
            settle(null, "could not open a GATT connection to the peer")
        }
    }

    private fun refreshGattCache(gatt: BluetoothGatt) {
        try {
            gatt.javaClass.getMethod("refresh").invoke(gatt)
        } catch (_: Exception) {
        }
    }
}
