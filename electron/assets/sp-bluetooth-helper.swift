import CoreBluetooth
import Foundation
import IOBluetooth

let syncServiceUUID = CBUUID(string: "7A9C1E40-5B3D-4F21-9C86-2E1D0A7B4F33")
let psmCharacteristicUUID = CBUUID(string: "7A9C1E44-5B3D-4F21-9C86-2E1D0A7B4F33")
let advertisedLocalName = "SuperProductivitySync"
let streamChunkBytes = 65536

func writeLine(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func writeError(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

func respond(id: Int, result: Any?) {
    writeLine(["id": id, "ok": true, "result": result ?? NSNull()])
}

func respondError(id: Int, message: String) {
    writeLine(["id": id, "ok": false, "error": message])
}

final class LinkChannel: NSObject, StreamDelegate {
    let linkId: String
    private let channel: CBL2CAPChannel
    private let input: InputStream
    private let output: OutputStream
    private var pendingOutbound = Data()
    private var isClosed = false
    private let onClosed: (String) -> Void

    init(linkId: String, channel: CBL2CAPChannel, onClosed: @escaping (String) -> Void) {
        self.linkId = linkId
        self.channel = channel
        self.input = channel.inputStream
        self.output = channel.outputStream
        self.onClosed = onClosed
        super.init()
        input.delegate = self
        output.delegate = self
        input.schedule(in: .main, forMode: .default)
        output.schedule(in: .main, forMode: .default)
        input.open()
        output.open()
    }

    func enqueue(_ data: Data) {
        pendingOutbound.append(data)
        pumpOutbound()
    }

    func close(reason: String) {
        guard !isClosed else { return }
        isClosed = true
        input.close()
        output.close()
        input.remove(from: .main, forMode: .default)
        output.remove(from: .main, forMode: .default)
        onClosed(reason)
    }

    func stream(_ stream: Stream, handle event: Stream.Event) {
        switch event {
        case .hasBytesAvailable:
            drainInbound()
        case .hasSpaceAvailable:
            pumpOutbound()
        case .errorOccurred:
            close(reason: stream.streamError?.localizedDescription ?? "stream error")
        case .endEncountered:
            close(reason: "peer closed the channel")
        default:
            break
        }
    }

    private func drainInbound() {
        var buffer = [UInt8](repeating: 0, count: streamChunkBytes)
        while input.hasBytesAvailable {
            let read = input.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { return }
            writeLine([
                "event": "data",
                "linkId": linkId,
                "dataBase64": Data(buffer[0..<read]).base64EncodedString(),
            ])
        }
    }

    private func pumpOutbound() {
        while !pendingOutbound.isEmpty && output.hasSpaceAvailable {
            let written = pendingOutbound.withUnsafeBytes { raw -> Int in
                guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return -1 }
                return output.write(base, maxLength: pendingOutbound.count)
            }
            guard written > 0 else { return }
            pendingOutbound = pendingOutbound.dropFirst(written)
        }
    }
}

final class BluetoothHelper: NSObject, CBPeripheralManagerDelegate, CBCentralManagerDelegate,
    CBPeripheralDelegate
{
    private var peripheralManager: CBPeripheralManager!
    private var centralManager: CBCentralManager!
    private var publishedPSM: CBL2CAPPSM = 0
    private var isServicePublished = false
    private var linksById: [String: LinkChannel] = [:]
    private var nextLinkSequence = 0

    private var startListeningCommandId: Int?
    private var pendingConnectByPeripheralId: [UUID: Int] = [:]
    private var connectingPeripherals: [UUID: CBPeripheral] = [:]

    func start() {
        peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
        centralManager = CBCentralManager(delegate: self, queue: nil)
    }

    func handleCommand(_ command: [String: Any]) {
        guard let id = command["id"] as? Int, let cmd = command["cmd"] as? String else {
            return
        }
        switch cmd {
        case "isAvailable":
            respond(id: id, result: ["isAvailable": peripheralManager.state == .poweredOn])
        case "localDeviceName":
            respond(id: id, result: ["deviceName": Host.current().localizedName ?? "Mac"])
        case "listPaired":
            respond(id: id, result: pairedDevices())
        case "startListening":
            beginListening(commandId: id)
        case "connect":
            connect(commandId: id, command: command)
        case "write":
            write(commandId: id, command: command)
        case "close":
            closeLink(commandId: id, command: command)
        default:
            respondError(id: id, message: "Unknown command \(cmd)")
        }
    }

    private func pairedDevices() -> [[String: Any]] {
        guard let devices = IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice] else {
            return []
        }
        return devices.map { device in
            [
                "platformAddress": device.addressString ?? "",
                "deviceName": device.name ?? device.addressString ?? "Unknown",
                "isCurrentlyConnected": device.isConnected(),
            ]
        }
    }

    private func beginListening(commandId: Int) {
        guard peripheralManager.state == .poweredOn else {
            respondError(id: commandId, message: "Bluetooth is not powered on")
            return
        }
        if isServicePublished {
            respond(id: commandId, result: ["psm": Int(publishedPSM)])
            return
        }
        startListeningCommandId = commandId
        peripheralManager.publishL2CAPChannel(withEncryption: true)
    }

    private func connect(commandId: Int, command: [String: Any]) {
        guard let identifierText = command["platformAddress"] as? String,
            let identifier = UUID(uuidString: identifierText)
        else {
            respondError(
                id: commandId,
                message:
                    "macOS addresses peers by CoreBluetooth identifier; this member has none yet")
            return
        }
        let known = centralManager.retrievePeripherals(withIdentifiers: [identifier])
        guard let peripheral = known.first else {
            respondError(id: commandId, message: "CoreBluetooth does not know this peer")
            return
        }
        peripheral.delegate = self
        connectingPeripherals[identifier] = peripheral
        pendingConnectByPeripheralId[identifier] = commandId
        centralManager.connect(peripheral, options: nil)
    }

    private func write(commandId: Int, command: [String: Any]) {
        guard let linkId = command["linkId"] as? String,
            let dataBase64 = command["dataBase64"] as? String,
            let data = Data(base64Encoded: dataBase64)
        else {
            respondError(id: commandId, message: "Malformed write command")
            return
        }
        guard let link = linksById[linkId] else {
            respondError(id: commandId, message: "Unknown link \(linkId)")
            return
        }
        link.enqueue(data)
        respond(id: commandId, result: nil)
    }

    private func closeLink(commandId: Int, command: [String: Any]) {
        guard let linkId = command["linkId"] as? String else {
            respondError(id: commandId, message: "Malformed close command")
            return
        }
        linksById[linkId]?.close(reason: "closed locally")
        respond(id: commandId, result: nil)
    }

    private func registerLink(_ channel: CBL2CAPChannel, peerDeviceId: String, isIncoming: Bool)
        -> String
    {
        nextLinkSequence += 1
        let linkId = "link-\(nextLinkSequence)"
        let link = LinkChannel(linkId: linkId, channel: channel) { [weak self] reason in
            self?.linksById.removeValue(forKey: linkId)
            writeLine(["event": "linkClosed", "linkId": linkId, "reason": reason])
        }
        linksById[linkId] = link
        if isIncoming {
            writeLine([
                "event": "incomingLink", "linkId": linkId, "peerDeviceId": peerDeviceId,
            ])
        }
        return linkId
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {}

    func centralManagerDidUpdateState(_ central: CBCentralManager) {}

    func peripheralManager(
        _ peripheral: CBPeripheralManager, didPublishL2CAPChannel PSM: CBL2CAPPSM, error: Error?
    ) {
        if let error {
            if let commandId = startListeningCommandId {
                respondError(id: commandId, message: error.localizedDescription)
                startListeningCommandId = nil
            }
            return
        }
        publishedPSM = PSM
        var psmValue = PSM.littleEndian
        let psmCharacteristic = CBMutableCharacteristic(
            type: psmCharacteristicUUID, properties: [.read],
            value: Data(bytes: &psmValue, count: MemoryLayout<CBL2CAPPSM>.size),
            permissions: [.readable])
        let service = CBMutableService(type: syncServiceUUID, primary: true)
        service.characteristics = [psmCharacteristic]
        peripheral.add(service)
    }

    func peripheralManager(
        _ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?
    ) {
        if let error {
            if let commandId = startListeningCommandId {
                respondError(id: commandId, message: error.localizedDescription)
                startListeningCommandId = nil
            }
            return
        }
        peripheral.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [syncServiceUUID],
            CBAdvertisementDataLocalNameKey: advertisedLocalName,
        ])
    }

    func peripheralManagerDidStartAdvertising(
        _ peripheral: CBPeripheralManager, error: Error?
    ) {
        guard let commandId = startListeningCommandId else { return }
        startListeningCommandId = nil
        if let error {
            respondError(id: commandId, message: error.localizedDescription)
            return
        }
        isServicePublished = true
        respond(id: commandId, result: ["psm": Int(publishedPSM)])
    }

    func peripheralManager(
        _ peripheral: CBPeripheralManager, didOpen channel: CBL2CAPChannel?, error: Error?
    ) {
        guard let channel, error == nil else { return }
        _ = registerLink(
            channel, peerDeviceId: channel.peer.identifier.uuidString, isIncoming: true)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([syncServiceUUID])
    }

    func centralManager(
        _ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?
    ) {
        failConnect(peripheral, message: error?.localizedDescription ?? "connect failed")
    }

    func centralManager(
        _ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        failConnect(peripheral, message: error?.localizedDescription ?? "disconnected")
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == syncServiceUUID })
        else {
            failConnect(peripheral, message: "peer does not expose the sync service")
            return
        }
        peripheral.discoverCharacteristics([psmCharacteristicUUID], for: service)
    }

    func peripheral(
        _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        guard
            let characteristic = service.characteristics?.first(where: {
                $0.uuid == psmCharacteristicUUID
            })
        else {
            failConnect(peripheral, message: "peer does not expose the PSM characteristic")
            return
        }
        peripheral.readValue(for: characteristic)
    }

    func peripheral(
        _ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard let value = characteristic.value, value.count >= 2 else {
            failConnect(peripheral, message: "peer returned no PSM")
            return
        }
        let psm = CBL2CAPPSM(value[0]) | (CBL2CAPPSM(value[1]) << 8)
        peripheral.openL2CAPChannel(psm)
    }

    func peripheral(
        _ peripheral: CBPeripheral, didOpen channel: CBL2CAPChannel?, error: Error?
    ) {
        guard let commandId = pendingConnectByPeripheralId.removeValue(
            forKey: peripheral.identifier)
        else { return }
        connectingPeripherals.removeValue(forKey: peripheral.identifier)
        guard let channel, error == nil else {
            respondError(
                id: commandId, message: error?.localizedDescription ?? "L2CAP open failed")
            return
        }
        let linkId = registerLink(
            channel, peerDeviceId: peripheral.identifier.uuidString, isIncoming: false)
        respond(id: commandId, result: ["linkId": linkId])
    }

    private func failConnect(_ peripheral: CBPeripheral, message: String) {
        guard let commandId = pendingConnectByPeripheralId.removeValue(
            forKey: peripheral.identifier)
        else { return }
        connectingPeripherals.removeValue(forKey: peripheral.identifier)
        respondError(id: commandId, message: message)
    }
}

let helper = BluetoothHelper()
helper.start()

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
            let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            writeError("unparsable command")
            continue
        }
        DispatchQueue.main.async { helper.handleCommand(command) }
    }
    exit(0)
}

RunLoop.main.run()
