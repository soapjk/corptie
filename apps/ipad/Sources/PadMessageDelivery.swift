import Foundation
import CorptieClientCore
import CorptieClientSecurity
import OSLog

/// One foreground-owned sender, independent of navigation and model execution.
/// All retries use the same immutable message identity/content. No ordinary
/// command, approval, stop or scheduled operation passes through this sender.
extension PadWorkspace {
    private static let deliveryLog = Logger(subsystem: "com.corptie.mobile", category: "MessageDelivery")

    func deliveryKey(_ connection: PadConnection) -> String {
        "\(connection.serverID)|\(connection.deviceID ?? "")|\(connection.connected)|\(connection.networkAvailable)|\(connection.recoveryBlockedMessage ?? "")|\(connection.recoveryRevision)|\(deliveryRevision)"
    }

    func enqueueReliableMessage(_ connection: PadConnection, sessionID: String, displaySessionID: String,
                                text: String, images: [ClientDraftImage], mentions: [ClientDraftMention],
                                clearsDraft: Bool) async {
        guard !outboxSaving, let deviceID = connection.deviceID, !connection.serverID.isEmpty else {
            status = "尚未建立可信连接，消息仍保留在草稿中。"
            return
        }
        outboxSaving = true
        defer { outboxSaving = false }
        let message = ReliableOutgoingMessage(serverID: connection.serverID, deviceID: deviceID,
            sessionID: sessionID, displaySessionID: displaySessionID, text: text, images: images, mentions: mentions)
        do {
            try await messageOutbox.save(message)
            if clearsDraft, drafts[displaySessionID] == text,
               (draftImages[displaySessionID] ?? []).map(\.id) == images.map(\.id),
               (draftMentions[displaySessionID] ?? []).map(\.id) == mentions.map(\.id) {
                drafts[displaySessionID] = ""; draftImages[displaySessionID] = []; draftMentions[displaySessionID] = []
            }
            projectReliableMessage(message, title: "已保存，等待发送")
            scrollRequest += 1
            recordSessionActivity(sessionID: displaySessionID, timestamp: message.createdAt)
            status = ""
            deliveryRevision += 1
            Self.deliveryLog.info("Message saved: request=\(message.id, privacy: .public)")
        } catch {
            status = "消息未保存，草稿已保留。请检查设备存储空间或稍后重试。"
        }
    }

    private func projectReliableMessage(_ message: ReliableOutgoingMessage, title: String) {
        let id = message.authoritativeMessageID ?? message.messageID
        let sessionID = message.displaySessionID
        // Do not reinsert authoritative messages on every retry/foreground resume.
        let authoritative = hasAuthoritativeMessage(id, sessionID: sessionID)
        if !authoritative, !(outgoingMessages[sessionID] ?? []).contains(where: { $0.id == id }) {
            outgoingMessages[sessionID, default: []].append(ClientMessage(id: id,
                text: message.text.isEmpty ? "图片消息" : message.text))
        }
        if !authoritative, outgoingStates[id] != title { outgoingStates[id] = title }
    }

    /// Stops future attempts, not a withdrawal of an already in-flight message.
    /// Keep the encrypted record and identity so the user never loses the text.
    func stopReliableRetries(_ connection: PadConnection, displaySessionID: String) async {
        guard let id = deliveryIssues[displaySessionID] else { return }
        do {
            guard var record = try await messageOutbox.all().first(where: { $0.id == id }),
                  record.serverID == connection.serverID, record.deviceID == connection.deviceID,
                  record.state != .accepted else { return }
            deliveryRevision += 1 // cancel the foreground-owned attempt before persisting
            record.state = .cancelled
            try await messageOutbox.save(record)
            deliveryIssues.removeValue(forKey: displaySessionID)
            projectReliableMessage(record, title: "已停止重试；不代表撤回")
            status = "已停止自动发送，原消息保留在本机；若请求已到达后端，它仍可能执行。"
        } catch { status = "无法保存停止状态，原消息仍保留，请稍后重试。" }
    }

    static func deliveryFailureIsPermanent(_ error: Error) -> Bool {
        if let failure = error as? CloudRelayTransportError {
            return failure == .responseTooLarge || failure == .unsupportedRequest
        }
        guard let failure = error as? ClientServiceFailure else { return false }
        if ["SESSION_BUSY", "SESSION_NOT_READY", "COMMAND_JOURNAL_FULL"].contains(failure.code) { return false }
        return [400, 404, 409, 410, 413, 422].contains(failure.statusCode)
    }

    static func retryInterval(attempt: Int, jitter: Double = Double.random(in: 0.8...1.2)) -> Double {
        min(30, pow(2, Double(min(max(0, attempt - 1), 5))) * max(0.5, min(1.5, jitter)))
    }

    func runMessageDelivery(_ connection: PadConnection) async {
        let serverID = connection.serverID, deviceID = connection.deviceID
        guard !serverID.isEmpty, let deviceID else { return }
        let generation = deliveryKey(connection)
        deliveryIssues = [:]
        let acknowledgementScope = "\(serverID)|\(deviceID)"
        if restoredAcknowledgementScope != acknowledgementScope {
            do {
                for acknowledgement in try await messageOutbox.acceptedIdentities()
                    where acknowledgement.serverID == serverID && acknowledgement.deviceID == deviceID {
                    guard !Task.isCancelled, deliveryKey(connection) == generation else { return }
                    acknowledgeOutgoing(localID: acknowledgement.localMessageID, messageID: acknowledgement.messageID,
                        sessionID: acknowledgement.sessionID)
                }
                restoredAcknowledgementScope = acknowledgementScope
            } catch {
                status = "发送回执读取失败，本地消息已保留。请检查存储空间后重试。"
                return
            }
        }
        while !Task.isCancelled, deliveryKey(connection) == generation {
            let records: [ReliableOutgoingMessage]
            do { records = try await messageOutbox.all().filter { $0.serverID == serverID && $0.deviceID == deviceID } }
            catch {
                status = "待发送消息读取失败，已保留本地记录。请检查存储空间或重新打开 App。"
                return
            }
            var blockedSessions = Set<String>()
            var retryScheduled = false
            var nextWake = Date().addingTimeInterval(30)
            for var message in records {
                guard !Task.isCancelled, deliveryKey(connection) == generation else { return }
                if message.state == .accepted {
                    guard let messageID = message.authoritativeMessageID else {
                        projectReliableMessage(message, title: "旧请求需核对；不会自动重发")
                        deliveryIssues[message.displaySessionID] = message.id
                        blockedSessions.insert(message.sessionID)
                        continue
                    }
                    do { try await messageOutbox.acknowledge(message, messageID: messageID) } catch { return }
                    acknowledgeOutgoing(localID: message.messageID, messageID: messageID, sessionID: message.displaySessionID)
                    projectReliableMessage(message, title: "后端已接收")
                    // Durable backend ownership releases local attachment storage.
                    do { try await messageOutbox.remove(message.id) } catch { return }
                    continue
                }
                if message.state == .cancelled {
                    projectReliableMessage(message, title: "已停止重试；不代表撤回")
                    continue
                }
                if message.state == .rejected {
                    projectReliableMessage(message, title: "发送失败：\(message.errorCode ?? "请求被拒绝")")
                    // Later instructions must not overtake a definitively rejected predecessor.
                    blockedSessions.insert(message.sessionID)
                    deliveryIssues[message.displaySessionID] = message.id
                    continue
                }
                if blockedSessions.contains(message.sessionID) {
                    projectReliableMessage(message, title: "等待前一条消息处理")
                    continue
                }
                blockedSessions.insert(message.sessionID)
                if message.attempts >= 5 || message.state == .blocked {
                    deliveryIssues[message.displaySessionID] = message.id
                }
                guard connection.connected, connection.networkAvailable,
                      connection.recoveryBlockedMessage == nil else {
                    projectReliableMessage(message, title: connection.recoveryBlockedMessage == nil
                        ? "等待网络，恢复后自动发送" : "等待恢复连接授权")
                    continue
                }
                if message.nextAttemptAt > Date() && message.state != .blocked {
                    retryScheduled = true
                    nextWake = min(nextWake, message.nextAttemptAt)
                    projectReliableMessage(message, title: "等待重试，将自动发送")
                    continue
                }
                projectReliableMessage(message, title: "发送中")
                do {
                    let transport = try await connection.transport()
                    let api = ClientSessionAPI(transport: transport)
                    guard !Task.isCancelled, deliveryKey(connection) == generation else { return }
                    let identityScope = "\(serverID)|\(deviceID)|\(connection.recoveryRevision)"
                    if validatedDeliveryIdentityScope != identityScope {
                        let request = try transport.endpoint.request(path: ["client", "v1", "me"])
                        let (data, _) = try await transport.data(for: request)
                        struct Identity: Decodable { let deviceId: String; let serverId: String }
                        let identity = try JSONDecoder().decode(Identity.self, from: data)
                        guard identity.deviceId == deviceID, identity.serverId == serverID else {
                            throw ClientServiceFailure(statusCode: 409, code: "MESSAGE_IDENTITY_UNAVAILABLE")
                        }
                        validatedDeliveryIdentityScope = identityScope
                    }
                    guard !Task.isCancelled, deliveryKey(connection) == generation else { return }
                    // Negotiated before enqueue; the immutable v1 endpoint is
                    // safe to retry directly. An extra capabilities read adds
                    // an RTT and can hide an accepted receipt after Session deletion.
                    let receipt: ClientCommandReceipt
                    if message.messageIdentityVersion != 2 {
                        // No blind replay across the old shared relay identity.
                        // Query only; absence cannot prove a previous request failed.
                        do {
                            receipt = try await api.receipt(requestId: message.id)
                            if receipt.status != "accepted" {
                                throw ClientServiceFailure(statusCode: 409, code: "LEGACY_MESSAGE_REQUIRES_RECONCILIATION")
                            }
                        }
                        catch let failure as ClientServiceFailure where failure.statusCode == 404 {
                            throw ClientServiceFailure(statusCode: 409, code: "LEGACY_MESSAGE_REQUIRES_RECONCILIATION")
                        }
                    } else {
                        receipt = try await api.deliver(sessionId: message.sessionID, requestId: message.id,
                            createdAt: message.createdAt, text: message.text, images: message.images, mentions: message.mentions)
                    }
                    guard !Task.isCancelled, deliveryKey(connection) == generation else { return }
                    guard receipt.requestId == message.id, receipt.sessionId == message.sessionID,
                          receipt.kind == "send", receipt.status == "accepted" else {
                        throw ClientConnectionError.invalidResponse
                    }
                    guard let messageID = receipt.messageId, messageID.hasPrefix("client:"), messageID.count <= 200 else {
                        throw ClientServiceFailure(statusCode: 409, code: "MESSAGE_IDENTITY_UNAVAILABLE")
                    }
                    message.state = .accepted; message.errorCode = nil
                    message.authoritativeMessageID = messageID
                    try await messageOutbox.save(message)
                    try await messageOutbox.acknowledge(message, messageID: messageID)
                    acknowledgeOutgoing(localID: message.messageID, messageID: messageID, sessionID: message.displaySessionID)
                    if deliveryIssues[message.displaySessionID] == message.id {
                        deliveryIssues.removeValue(forKey: message.displaySessionID)
                    }
                    projectReliableMessage(message, title: "后端已接收")
                    blockedSessions.remove(message.sessionID)
                    do { try await messageOutbox.remove(message.id) }
                    catch { Self.deliveryLog.error("Accepted message cleanup deferred: request=\(message.id, privacy: .public)") }
                    inventoryDirty = true; messagesDirty = true
                    scheduleRefresh(connection)
                    Self.deliveryLog.info("Message accepted: request=\(message.id, privacy: .public)")
                } catch is CancellationError { return }
                catch {
                    guard !Task.isCancelled, deliveryKey(connection) == generation else { return }
                    if message.state == .accepted {
                        status = "后端已接收，但本地回执保存未完成。原记录已保留，稍后继续核对。"
                        return
                    }
                    if connection.stopRecoveryIfUnauthorized(error) {
                        message.state = .blocked; message.errorCode = "等待恢复连接授权"
                    } else if ["MESSAGE_IDENTITY_UNAVAILABLE", "LEGACY_MESSAGE_REQUIRES_RECONCILIATION"].contains((error as? ClientServiceFailure)?.code ?? "") {
                        message.state = .blocked
                        message.errorCode = (error as? ClientServiceFailure)?.code == "MESSAGE_IDENTITY_UNAVAILABLE"
                            ? "发送身份未对齐，请更新 Mac 并重新连接" : "旧请求需核对；不会自动重发"
                    } else if (error as? ClientServiceFailure)?.code == "ROUTE_NOT_AVAILABLE" {
                        message.state = .blocked; message.errorCode = "后端不支持可靠发送，请更新后端"
                    } else if Self.deliveryFailureIsPermanent(error) {
                        message.state = .rejected
                        message.errorCode = (error as? CloudRelayTransportError) == .responseTooLarge
                            ? "远程请求超过大小限制，请缩小附件或使用局域网连接"
                            : (error as? ClientServiceFailure)?.code ?? "请求被拒绝"
                    } else {
                        message.state = .waiting; message.attempts += 1
                        retryScheduled = true
                        message.nextAttemptAt = Date().addingTimeInterval(Self.retryInterval(attempt: message.attempts))
                        message.errorCode = nil
                        nextWake = min(nextWake, message.nextAttemptAt)
                    }
                    do { try await messageOutbox.save(message) } catch {
                        status = "发送状态保存失败，原消息仍保留，稍后继续核对。"
                        return
                    }
                    if message.state == .rejected || message.state == .blocked || message.attempts >= 5 {
                        deliveryIssues[message.displaySessionID] = message.id
                    }
                    let title = message.state == .rejected ? "发送失败：\(message.errorCode ?? "请求被拒绝")"
                        : message.state == .blocked ? (message.errorCode ?? "等待恢复连接授权") : "等待重试，将自动发送"
                    projectReliableMessage(message, title: title)
                    Self.deliveryLog.info("Message attempt deferred: request=\(message.id, privacy: .public), attempt=\(message.attempts), state=\(message.state.rawValue, privacy: .public)")
                }
            }
            // Idle/offline workers suspend; network and foreground changes wake
            // through the root task's identity, not a high-frequency timer.
            if !retryScheduled
                || !connection.networkAvailable || !connection.connected
                || connection.recoveryBlockedMessage != nil { return }
            do { try await Task.sleep(for: .seconds(max(0.2, nextWake.timeIntervalSinceNow))) }
            catch { return }
        }
    }
}
