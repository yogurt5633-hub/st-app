import XCTest

final class ConnectionUITests: XCTestCase {
    func testConnectionScreenAndValidation() {
        let app = XCUIApplication()
        app.launch()
        let field = app.textFields["Адрес SillyTavern"]
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "iPhone connection screen"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        field.tap()
        field.typeText("https://example.org/path")
        app.buttons["Подключиться"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Ошибка:")).firstMatch.waitForExistence(timeout: 5))
        app.tabBars.buttons["Таверна"].tap()
        XCTAssertTrue(app.staticTexts["Сначала подключите Таверну"].exists)
        app.buttons["Указать адрес"].tap()
        XCTAssertTrue(field.exists)
    }
}
