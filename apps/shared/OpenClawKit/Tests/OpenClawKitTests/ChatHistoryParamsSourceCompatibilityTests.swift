import OpenClawProtocol
import XCTest

final class ChatHistoryParamsSourceCompatibilityTests: XCTestCase {
    func testOptionalCursorCanBeOmitted() {
        let params = ChatHistoryParams(sessionkey: "session-1", limit: 50)

        XCTAssertNil(params.before)
    }
}
