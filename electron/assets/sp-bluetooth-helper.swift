import CoreBluetooth
import Foundation
import IOBluetooth

let syncServiceUUID = CBUUID(string: "7A9C1E40-5B3D-4F21-9C86-2E1D0A7B4F33")
let psmCharacteristicUUID = CBUUID(string: "7A9C1E44-5B3D-4F21-9C86-2E1D0A7B4F33")
let advertisedLocalName = "SuperProductivitySync"
let streamChunkBytes = 65536
let powerOnDeadlineSeconds = 5.0
let peerSearchSeconds = 15.0
let connectSeconds = 20.0

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

struct ConnectRequest {
    let commandId: Int
    let pairedAddress: String
    let deviceName: String
    var hasSearchedAgain = false

    func searchingAgain() -> ConnectRequest {
        ConnectRequest(
            commandId: commandId, pairedAddress: pairedAddress, deviceName: deviceName,
            hasSearchedAgain: true)
    }
}

final class PeerSearch {
    let request: ConnectRequest
    var namesSeen: Set<String> = []

    init(request: ConnectRequest) {
        self.request = request
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
    private var commandsAwaitingPowerOn: [[String: Any]] = []
    private var hasScheduledPowerOnDeadline = false
    private var pendingConnectByPeripheralId: [UUID: ConnectRequest] = [:]
    private var connectingPeripherals: [UUID: CBPeripheral] = [:]
    private var peerSearches: [PeerSearch] = []
    private var peripheralIdentifiersByPairedAddress: [String: UUID] = [:]
    private var peripheralsBeingNamed: [UUID: CBPeripheral] = [:]
    private var peripheralsRuledOut: Set<UUID> = []

    func start() {
        peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
        centralManager = CBCentralManager(delegate: self, queue: nil)
    }

    func handleCommand(_ command: [String: Any]) {
        guard let id = command["id"] as? Int, let cmd = command["cmd"] as? String else {
            return
        }
        if peripheralManager.state == .unknown && cmd != "localDeviceName" {
            commandsAwaitingPowerOn.append(command)
            schedulePowerOnDeadline()
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

    /// CoreBluetooth reports its state asynchronously, and a process without a
    /// usable Bluetooth grant never leaves .unknown at all. Commands wait for the
    /// first state, then fail rather than hanging the caller forever.
    private func schedulePowerOnDeadline() {
        guard !hasScheduledPowerOnDeadline else { return }
        hasScheduledPowerOnDeadline = true
        DispatchQueue.main.asyncAfter(deadline: .now() + powerOnDeadlineSeconds) { [weak self] in
            guard let self, self.peripheralManager.state == .unknown else { return }
            let queued = self.commandsAwaitingPowerOn
            self.commandsAwaitingPowerOn = []
            for command in queued {
                guard let id = command["id"] as? Int else { continue }
                if command["cmd"] as? String == "isAvailable" {
                    respond(id: id, result: ["isAvailable": false])
                } else {
                    respondError(
                        id: id,
                        message: "Bluetooth did not become available for this app")
                }
            }
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
        peripheralManager.publishL2CAPChannel(withEncryption: false)
    }

    private func connect(commandId: Int, command: [String: Any]) {
        guard let addressText = command["platformAddress"] as? String, !addressText.isEmpty
        else {
            respondError(id: commandId, message: "Malformed connect command")
            return
        }
        let deviceName = (command["deviceName"] as? String) ?? ""
        let request = ConnectRequest(
            commandId: commandId, pairedAddress: addressText, deviceName: deviceName)
        if let identifier = UUID(uuidString: addressText)
            ?? peripheralIdentifiersByPairedAddress[addressText]
        {
            connectToKnownPeripheral(request, identifier: identifier)
            return
        }
        guard !deviceName.isEmpty else {
            respondError(
                id: commandId,
                message: "This member has no Bluetooth name for macOS to look for")
            return
        }
        searchForAdvertisedPeer(request)
    }

    private func connectToKnownPeripheral(_ request: ConnectRequest, identifier: UUID) {
        guard let peripheral = centralManager.retrievePeripherals(withIdentifiers: [identifier])
            .first
        else {
            forgetResolvedIdentifier(for: request)
            retryOrFail(request, message: "CoreBluetooth does not know this peer")
            return
        }
        beginConnect(request, peripheral: peripheral)
    }

    private func beginConnect(_ request: ConnectRequest, peripheral: CBPeripheral) {
        peripheral.delegate = self
        connectingPeripherals[peripheral.identifier] = peripheral
        pendingConnectByPeripheralId[peripheral.identifier] = request
        centralManager.connect(peripheral, options: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + connectSeconds) { [weak self] in
            guard let self,
                self.pendingConnectByPeripheralId[peripheral.identifier]?.commandId
                    == request.commandId
            else { return }
            self.centralManager.cancelPeripheralConnection(peripheral)
            self.failConnect(
                peripheral,
                message:
                    "pairing with \(request.deviceName.isEmpty ? "the peer" : request.deviceName) never completed -- forget it in Bluetooth settings on BOTH devices, then pair again from the phone"
            )
        }
    }

    private func forgetResolvedIdentifier(for request: ConnectRequest) {
        peripheralIdentifiersByPairedAddress.removeValue(forKey: request.pairedAddress)
    }

    private func retryOrFail(_ request: ConnectRequest, message: String) {
        guard !request.hasSearchedAgain, !request.deviceName.isEmpty,
            UUID(uuidString: request.pairedAddress) == nil
        else {
            respondError(id: request.commandId, message: message)
            return
        }
        searchForAdvertisedPeer(request.searchingAgain())
    }

    private func searchForAdvertisedPeer(_ request: ConnectRequest) {
        guard centralManager.state == .poweredOn else {
            respondError(id: request.commandId, message: "Bluetooth is not powered on")
            return
        }
        peerSearches.append(PeerSearch(request: request))
        centralManager.scanForPeripherals(
            withServices: [syncServiceUUID],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        DispatchQueue.main.asyncAfter(deadline: .now() + peerSearchSeconds) { [weak self] in
            self?.abandonPeerSearch(commandId: request.commandId)
        }
    }

    private func abandonPeerSearch(commandId: Int) {
        guard let index = peerSearches.firstIndex(where: { $0.request.commandId == commandId })
        else { return }
        let search = peerSearches.remove(at: index)
        stopScanningWhenNothingIsWanted()
        let alsoSaw =
            search.namesSeen.isEmpty
            ? "no other device was advertising it"
            : "nearby devices advertising it: \(search.namesSeen.sorted().joined(separator: ", "))"
        respondError(
            id: commandId,
            message:
                "\(search.request.deviceName) is not offering Super Productivity sync -- \(alsoSaw)"
        )
    }

    private func stopScanningWhenNothingIsWanted() {
        guard peerSearches.isEmpty else { return }
        centralManager.stopScan()
        for peripheral in peripheralsBeingNamed.values {
            centralManager.cancelPeripheralConnection(peripheral)
        }
        peripheralsBeingNamed.removeAll()
        peripheralsRuledOut.removeAll()
    }

    private func askPeripheralItsName(_ peripheral: CBPeripheral) {
        guard !peerSearches.isEmpty,
            pendingConnectByPeripheralId[peripheral.identifier] == nil,
            peripheralsBeingNamed[peripheral.identifier] == nil,
            !peripheralsRuledOut.contains(peripheral.identifier)
        else { return }
        peripheral.delegate = self
        peripheralsBeingNamed[peripheral.identifier] = peripheral
        centralManager.connect(peripheral, options: nil)
    }

    private func matchNamedPeripheral(_ peripheral: CBPeripheral) {
        guard peripheralsBeingNamed[peripheral.identifier] != nil,
            let name = peripheral.name, !name.isEmpty
        else { return }
        for search in peerSearches {
            search.namesSeen.insert(name)
        }
        guard
            let index = peerSearches.firstIndex(where: {
                isSameDeviceName($0.request.deviceName, name)
            })
        else {
            peripheralsBeingNamed.removeValue(forKey: peripheral.identifier)
            peripheralsRuledOut.insert(peripheral.identifier)
            centralManager.cancelPeripheralConnection(peripheral)
            return
        }
        let search = peerSearches.remove(at: index)
        peripheralsBeingNamed.removeValue(forKey: peripheral.identifier)
        peripheralIdentifiersByPairedAddress[search.request.pairedAddress] = peripheral.identifier
        stopScanningWhenNothingIsWanted()
        connectingPeripherals[peripheral.identifier] = peripheral
        pendingConnectByPeripheralId[peripheral.identifier] = search.request
        peripheral.discoverServices([syncServiceUUID])
    }

    private func isSameDeviceName(_ wanted: String, _ advertised: String) -> Bool {
        guard !advertised.isEmpty else { return false }
        let left = wanted.lowercased()
        let right = advertised.lowercased()
        return left.hasPrefix(right) || right.hasPrefix(left)
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

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        guard peripheral.state != .unknown else { return }
        hasScheduledPowerOnDeadline = false
        let queued = commandsAwaitingPowerOn
        commandsAwaitingPowerOn = []
        for command in queued { handleCommand(command) }
    }

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
        let psmCharacteristic = CBMutableCharacteristic(
            type: psmCharacteristicUUID, properties: [.read],
            value: nil,
            permissions: [.readable])
        let service = CBMutableService(type: syncServiceUUID, primary: true)
        service.characteristics = [psmCharacteristic]
        peripheral.add(service)
    }

    func peripheralManager(
        _ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest
    ) {
        guard request.characteristic.uuid == psmCharacteristicUUID else {
            peripheral.respond(to: request, withResult: .attributeNotFound)
            return
        }
        var psmValue = publishedPSM.littleEndian
        let psmData = Data(bytes: &psmValue, count: MemoryLayout<CBL2CAPPSM>.size)
        guard request.offset <= psmData.count else {
            peripheral.respond(to: request, withResult: .invalidOffset)
            return
        }
        request.value = psmData.subdata(in: request.offset..<psmData.count)
        peripheral.respond(to: request, withResult: .success)
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

    func centralManager(
        _ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any], rssi RSSI: NSNumber
    ) {
        let advertisedName =
            (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name ?? ""
        for search in peerSearches {
            search.namesSeen.insert(advertisedName.isEmpty ? "<unnamed>" : advertisedName)
        }
        guard
            let index = peerSearches.firstIndex(where: {
                isSameDeviceName($0.request.deviceName, advertisedName)
            })
        else {
            askPeripheralItsName(peripheral)
            return
        }
        let search = peerSearches.remove(at: index)
        peripheralIdentifiersByPairedAddress[search.request.pairedAddress] = peripheral.identifier
        stopScanningWhenNothingIsWanted()
        beginConnect(search.request, peripheral: peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        if peripheralsBeingNamed[peripheral.identifier] != nil {
            matchNamedPeripheral(peripheral)
            return
        }
        peripheral.discoverServices([syncServiceUUID])
    }

    func peripheralDidUpdateName(_ peripheral: CBPeripheral) {
        matchNamedPeripheral(peripheral)
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
        if let error {
            failConnect(peripheral, message: error.localizedDescription)
            return
        }
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
        if let error {
            failConnect(peripheral, message: error.localizedDescription)
            return
        }
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
        if let error {
            failConnect(
                peripheral,
                message:
                    "\(peripheral.name ?? "the peer") refused the sync handshake (\(error.localizedDescription)) -- forget the device in Bluetooth settings on both machines and pair them again"
            )
            return
        }
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
        guard let request = pendingConnectByPeripheralId.removeValue(
            forKey: peripheral.identifier)
        else { return }
        connectingPeripherals.removeValue(forKey: peripheral.identifier)
        guard let channel, error == nil else {
            respondError(
                id: request.commandId, message: error?.localizedDescription ?? "L2CAP open failed")
            return
        }
        let linkId = registerLink(
            channel, peerDeviceId: peripheral.identifier.uuidString, isIncoming: false)
        respond(id: request.commandId, result: ["linkId": linkId])
    }

    private func failConnect(_ peripheral: CBPeripheral, message: String) {
        guard let request = pendingConnectByPeripheralId.removeValue(
            forKey: peripheral.identifier)
        else { return }
        connectingPeripherals.removeValue(forKey: peripheral.identifier)
        forgetResolvedIdentifier(for: request)
        retryOrFail(request, message: message)
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
    DispatchQueue.main.async { exit(0) }
}

RunLoop.main.run()
