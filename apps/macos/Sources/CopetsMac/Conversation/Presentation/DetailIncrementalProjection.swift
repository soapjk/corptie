import Foundation

/// Value-only input to the production fast path; nil requests full shared projection.
struct DetailIncrementalProjection {
    let cachedSessionId: String
    let cachedSourceItemCount: Int
    let cachedSourcePenultimateItemId: String?
    let cachedSourceTailItem: CodexThreadItem?
    let cachedDisplayEntries: [ChatDisplayEntry]
    let cachedTotalDisplayEntryCount: Int
    let cachedVisibleMessageLimit: Int
    let cachedItemsSignature: String

    func project(
        for detail: CodexThreadDetail,
        sessionId: String,
        visibleMessageLimit: Int,
        requestedRestorationAnchorRowID: String? = nil
    ) -> (displayItems: [CodexThreadItem], visibleEntries: [ChatDisplayEntry], totalCount: Int, signature: String, sourceSignature: String)? {
        let tailTurnID = detail.items.last(where: { !isLowSignalDetailProcessItem($0) })?.turnId
        var nextDisplayItems: [CodexThreadItem] = []
        nextDisplayItems.reserveCapacity(detail.items.count)
        var firstTailTurnIndex: Int?
        // Fold coverage detection into the existing source-filter pass. No
        // historical hash, retained index or additional observer is needed.
        for item in detail.items where !isLowSignalDetailProcessItem(item) {
            if firstTailTurnIndex == nil, item.turnId == tailTurnID {
                firstTailTurnIndex = nextDisplayItems.count
            }
            nextDisplayItems.append(item)
        }
        guard requestedRestorationAnchorRowID == nil,
              cachedSessionId == sessionId,
              DetailTimelineIncrementalEligibility.canReuseCachedWindow(
                cachedVisibleMessageLimit: cachedVisibleMessageLimit,
                requestedVisibleMessageLimit: visibleMessageLimit
              ),
              cachedSourceItemCount > 0,
              nextDisplayItems.count >= cachedSourceItemCount,
              let cachedLast = cachedSourceTailItem,
              nextDisplayItems[cachedSourceItemCount - 1].id == cachedLast.id,
              nextDisplayItems[cachedSourceItemCount - 1].turnId == cachedLast.turnId,
              (cachedSourceItemCount < 2
                || nextDisplayItems[cachedSourceItemCount - 2].id == cachedSourcePenultimateItemId) else {
            return nil
        }

        let appendedItems = nextDisplayItems.dropFirst(cachedSourceItemCount)
        if let firstAppended = appendedItems.first,
           firstAppended.turnId != cachedLast.turnId {
            // A new source turn is independent from the cached tail. Project
            // only the appended delta; the bounded visible window may discard
            // old rows without revisiting the rest of the Session history.
            guard firstAppended.type == "userMessage",
                  !firstAppended.turnId.isEmpty,
                  firstTailTurnIndex == cachedSourceItemCount,
                  appendedItems.allSatisfy({ $0.turnId == firstAppended.turnId }),
                  nextDisplayItems[cachedSourceItemCount - 1] == cachedLast else { return nil }
            let appendedEntries = makeChatDisplayEntries(from: Array(appendedItems))
            guard canIncrementallyAppendChatDisplayEntries(
                cached: cachedDisplayEntries,
                appended: appendedEntries
            ) else { return nil }
            let combined = cachedDisplayEntries + appendedEntries
            return (
                displayItems: nextDisplayItems,
                visibleEntries: visibleDetailEntries(from: combined, limit: visibleMessageLimit),
                totalCount: cachedTotalDisplayEntryCount
                    + appendedEntries.reduce(0) { $0 + $1.displayWeight },
                signature: incrementalDisplaySignature(
                    previousSignature: cachedItemsSignature,
                    tailEntries: appendedEntries
                ),
                sourceSignature: makeDetailSourceSignature(for: detail, visibleMessageLimit: visibleMessageLimit)
            )
        }

        guard let nextLast = nextDisplayItems.last,
              nextLast.turnId == cachedLast.turnId else { return nil }
        let tailItems = nextDisplayItems.reversed().prefix { $0.turnId == nextLast.turnId }.reversed()
        // A whole projected turn can include earlier events separated by a
        // late event from another turn. Replacing it with only the contiguous
        // suffix would delete its user message. Let the shared full projector
        // recover ordering, reused IDs and collaboration boundaries instead.
        guard firstTailTurnIndex == nextDisplayItems.count - tailItems.count else { return nil }
        // Reused or missing provider turn IDs need the full ordered projection
        // so user-message boundaries can be recovered. The tail-only fast path
        // would otherwise collapse those recovered turns back into one group.
        guard tailItems.lazy.filter({ $0.type == "userMessage" }).prefix(2).count < 2 else {
            return nil
        }
        let nextTailEntries = makeChatDisplayEntriesForTurn(
            stableChronologicalChatItems(Array(tailItems))
        )
        guard let oldTailStart = cachedDisplayEntries.firstIndex(where: {
            chatDisplayEntryTurnId($0) == nextLast.turnId
        }) else {
            return nil
        }
        let oldTailEntries = cachedDisplayEntries[oldTailStart...]
        guard oldTailEntries.allSatisfy({ chatDisplayEntryTurnId($0) == nextLast.turnId }) else {
            return nil
        }

        let nextUserIDs = Set(tailItems.lazy.filter { $0.type == "userMessage" }.map(\.id))
        for entry in oldTailEntries {
            if case .message(let item) = entry.kind,
               item.type == "userMessage", !nextUserIDs.contains(item.id) {
                // Full projection decides whether this is a legitimate source
                // deletion or an unsafe cached boundary; never retain ghosts.
                return nil
            }
        }

        let oldTailWeight = oldTailEntries.reduce(0) { $0 + $1.displayWeight }
        let nextTailWeight = nextTailEntries.reduce(0) { $0 + $1.displayWeight }
        let combined = Array(cachedDisplayEntries[..<oldTailStart]) + nextTailEntries
        let visibleEntries = visibleDetailEntries(from: combined, limit: visibleMessageLimit)
        let totalCount = max(0, cachedTotalDisplayEntryCount - oldTailWeight + nextTailWeight)
        return (
            displayItems: nextDisplayItems,
            visibleEntries: visibleEntries,
            totalCount: totalCount,
            signature: incrementalDisplaySignature(
                previousSignature: cachedItemsSignature,
                tailEntries: nextTailEntries
            ),
            sourceSignature: makeDetailSourceSignature(for: detail, visibleMessageLimit: visibleMessageLimit)
        )
    }

    private func incrementalDisplaySignature(
        previousSignature: String,
        tailEntries: [ChatDisplayEntry]
    ) -> String {
        let tailSignature = tailEntries.map { entry in
            switch entry.kind {
            case .message(let item): return detailItemSignature(item)
            case .process(let turnId, let items):
                return turnId + ":" + items.suffix(1).map(detailItemSignature).joined()
            }
        }.joined(separator: "|")
        return "\(previousSignature.hashValue):\(tailSignature)"
    }
}

extension DetailIncrementalProjection {
    init(cache: DetailDisplayCache) {
        self.init(cachedSessionId: cache.sessionId,
                  cachedSourceItemCount: cache.displayItems.count,
                  cachedSourcePenultimateItemId: cache.displayItems.dropLast().last?.id,
                  cachedSourceTailItem: cache.displayItems.last,
                  cachedDisplayEntries: cache.displayEntries,
                  cachedTotalDisplayEntryCount: cache.totalDisplayEntryCount,
                  cachedVisibleMessageLimit: cache.visibleMessageLimit,
                  cachedItemsSignature: cache.signature)
    }
}
