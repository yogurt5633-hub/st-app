import XCTest
@testable import Tavernka

final class ServerAddressTests: XCTestCase {
    func testPrivateNetworksAndHTTPS() throws {
        for address in ["http://192.168.1.10:8000", "http://10.0.0.1:8000", "http://100.64.1.1:8000", "http://tavern.local:8000", "https://example.org", "http://[fd00::1]:8000"] {
            XCTAssertNotNil(try ServerAddress.parse(address))
        }
    }
    func testRejectsUnsafeAndAmbiguousAddresses() {
        for address in ["javascript:alert(1)", "file:///etc/passwd", "http://example.org", "https://user:pass@example.org", "https://example.org/path", "https://example.org/?token=abc", "https://example.org/#foo", "http://100.128.0.1", "http://172.32.1.1"] {
            XCTAssertThrowsError(try ServerAddress.parse(address), address)
        }
    }
    func testOriginIncludesPortAndScheme() {
        let base = URL(string: "https://example.org")!
        XCTAssertTrue(ServerAddress.sameOrigin(URL(string: "https://example.org:443/chat")!, base))
        XCTAssertFalse(ServerAddress.sameOrigin(URL(string: "https://example.org:8000")!, base))
        XCTAssertFalse(ServerAddress.sameOrigin(URL(string: "http://example.org")!, base))
        XCTAssertFalse(ServerAddress.sameOrigin(URL(string: "https://evil.example.org")!, base))
    }
}
