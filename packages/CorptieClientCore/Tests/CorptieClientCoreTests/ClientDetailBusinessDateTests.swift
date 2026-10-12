import Foundation
import Testing
@testable import CorptieClientCore

struct ClientDetailBusinessDateTests {
    private func fixture() throws -> ClientInspectorValue {
        try ClientDetailV2JSON.decode(Data(contentsOf: #require(Bundle.module.url(forResource: "detail-v2-business-dates", withExtension: "json", subdirectory: "Fixtures"))))
    }
    @MainActor @Test func actualBusinessStateConvergesAndPreservesUntouchedCards() throws {
        let f = try fixture(), profile = try #require(f["catalog"].text), caps = f["clientCapabilities"].items.compactMap(\.text)
        try ClientDetailV2JSON.validateEnvelope(f["snapshot"], commit: false)
        try ClientDetailV2JSON.validateEnvelope(f["commit"], commit: true)
        let state = try ClientDetailV2Catalog.decode(ClientDetailV2State.self, f["snapshot"])
        let commit = try ClientDetailV2Catalog.decode(ClientDetailV2Commit.self, f["commit"])
        try state.validate(catalogProfile: profile, clientCapabilities: caps)
        #expect(state.manifest.order.count == 10)
        #expect(throws: (any Error).self) { try state.validate(catalogProfile: profile, clientCapabilities: caps.filter { $0 != "detail.dateTime" }) }
        let document = try state.renderingDocument(catalogProfile: profile, clientCapabilities: caps)
        let store = ClientDetailStore(); try store.apply(.snapshot(document))
        let saved = try #require(store.orderedCards.first { $0.id == "business-recalls" })
        let next = try state.applying(commit, catalogProfile: profile, clientCapabilities: caps)
        #expect(next.stateHash == f["expectedStateHash"].text)
        #expect(next.templates == state.templates)
        let rendered = try next.renderingDocument(previous: state, document: document, catalogProfile: profile, clientCapabilities: caps)
        try store.apply(.snapshot(rendered))
        #expect(store.orderedCards.first { $0.id == "business-recalls" } === saved)
        for id in state.manifest.order where id != "business-schedules" {
            #expect(next.instances[id] == state.instances[id])
            #expect(rendered.cards.first { $0.id == id } == document.cards.first { $0.id == id })
        }
        for card in document.cards {
            let dates = card.nodes.filter { $0.kind == "detail.dateTime" }
            #expect(dates.count <= 40)
            for node in dates {
                let source = node.binding.flatMap { card.data[$0]?.text }
                #expect(card.v2Presentation?.dates[node.id] == source.flatMap(ClientDetailV2Catalog.date))
            }
            for page in card.v2Presentation?.collections.values ?? Dictionary<String, ClientDetailCollection>().values {
                #expect(page.order.count <= 20 && page.nextCursor == nil)
            }
        }
        #expect(document.cards.flatMap(\.nodes).filter { $0.kind == "detail.dateTime" }.count == 80)
        let before = try #require(document.cards.first { $0.id == "business-schedules" })
        let after = try #require(rendered.cards.first { $0.id == "business-schedules" })
        #expect(before.data["date0"] == nil && after.data["date0"] != nil)
        #expect(before.data["scheduledDate1"] != nil && after.data["scheduledDate1"] == nil)
        #expect(before.v2Presentation?.dates["date4"] == after.v2Presentation?.dates["date4"])
    }
    @Test func dateInstantsAndLocaleTimezoneFormattingStaySeparate() throws {
        let f = try fixture()
        for (raw, utc) in f["expectedDateInstants"].fields {
            let date = try #require(ClientDetailV2Catalog.date(raw))
            #expect(date == ClientDetailV2Catalog.date(try #require(utc.text)))
            for locale in ["en_US", "zh_CN", "fr_FR"] {
                for zone in ["UTC", "Asia/Shanghai", "America/Los_Angeles"] {
                    let formatter = DateFormatter(); formatter.locale = Locale(identifier: locale)
                    formatter.timeZone = try #require(TimeZone(identifier: zone))
                    formatter.dateStyle = .medium; formatter.timeStyle = .long
                    #expect(!formatter.string(from: date).isEmpty)
                    #expect(ClientDetailV2Catalog.date(raw) == date)
                }
            }
        }
        let early = try #require(ClientDetailV2Catalog.date("2026-11-01T01:30:00-07:00"))
        let late = try #require(ClientDetailV2Catalog.date("2026-11-01T01:30:00-08:00"))
        #expect(late.timeIntervalSince(early) == 3600)
        let springBefore = try #require(ClientDetailV2Catalog.date("2026-03-08T01:59:59-08:00"))
        let springAfter = try #require(ClientDetailV2Catalog.date("2026-03-08T03:00:00-07:00"))
        #expect(springAfter.timeIntervalSince(springBefore) == 1)
        #expect(ClientDetailV2Catalog.date("") == nil)
    }
}
