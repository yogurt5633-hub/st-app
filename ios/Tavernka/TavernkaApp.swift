import SwiftUI

@main
struct TavernkaApp: App {
    @StateObject private var connection = Connection()
    var body: some Scene {
        WindowGroup { RootView().environmentObject(connection).tint(Color(red: 0.50, green: 0.34, blue: 0.16)) }
    }
}
@MainActor
final class Connection: ObservableObject {
    @Published var server: URL?
    @Published var selection = 0
    @Published var revision = UUID()
    init() {
        if let saved = UserDefaults.standard.string(forKey: "server") { server = try? ServerAddress.parse(saved) }
    }
    func connect(_ text: String) throws {
        let url = try ServerAddress.parse(text)
        server = url
        UserDefaults.standard.set(url.absoluteString, forKey: "server")
        revision = UUID()
        selection = 1
    }
}
struct RootView: View {
    @EnvironmentObject private var connection: Connection
    var body: some View {
        TabView(selection: $connection.selection) {
            ConnectionView().tabItem { Label("Главная", systemImage: "house") }.tag(0)
            page("Таверна", path: "").tabItem { Label("Таверна", systemImage: "bubble.left.and.bubble.right") }.tag(1)
            page("Корректор", path: "api/plugins/korrektor/app/").tabItem { Label("Корректор", systemImage: "pencil.line") }.tag(2)
            page("Каталог", path: "api/plugins/korrektor/app/", fragment: "tools/catalog").tabItem { Label("Каталог", systemImage: "books.vertical") }.tag(3)
        }
    }
    @ViewBuilder private func page(_ title: String, path: String, fragment: String? = nil) -> some View {
        if let server = connection.server {
            var components: URLComponents { var c = URLComponents(url: server.appendingPathComponent(path), resolvingAgainstBaseURL: false)!; c.fragment = fragment; return c }
            BrowserScreen(title: title, server: server, url: components.url!).id("\(connection.revision)-\(title)")
        } else {
            VStack(spacing: 16) {
                Image(systemName: "network").font(.largeTitle)
                Text("Сначала подключите Таверну").font(.headline)
                Button("Указать адрес") { connection.selection = 0 }.buttonStyle(.borderedProminent)
            }.padding()
        }
    }
}
struct ConnectionView: View {
    @EnvironmentObject private var connection: Connection
    @State private var address = ""
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Ваши истории — рядом").font(.title2.weight(.semibold))
                    Text("Приложение подключается к SillyTavern на вашем компьютере или сервере. Компьютер должен оставаться включённым.").foregroundStyle(.secondary)
                }
                Section("Подключение") {
                    TextField("http://192.168.1.10:8000", text: $address)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityLabel("Адрес SillyTavern")
                    Button("Подключиться") {
                        do { try connection.connect(address); error = nil } catch { self.error = error.localizedDescription }
                    }.frame(minHeight: 44)
                    if let error { Text(error).foregroundStyle(.red).accessibilityLabel("Ошибка: \(error)") }
                }
                Section("Как подготовить компьютер") {
                    Text("1. Запустите SillyTavern. Для вкладок «Корректор» и «Каталог» установите плагин Корректор.")
                    Text("2. В config.yaml включите listen: true и добавьте IP iPhone в whitelist. Перезапустите Таверну.")
                    Text("3. Подключите устройства к одной Wi-Fi сети и укажите здесь адрес компьютера. 127.0.0.1 на iPhone указывает на сам телефон.")
                    Text("Для внешнего сервера используйте HTTPS. Пароль вводится на странице входа или в системном окне; в адрес его добавлять не нужно.")
                }
                Section { Text("Тестовая версия 0.1.0. SillyTavern работает на компьютере или сервере; приложение на iPhone её не запускает.").font(.footnote).foregroundStyle(.secondary) }
            }
            .navigationTitle("Тавернка")
            .onAppear { if address.isEmpty { address = connection.server?.absoluteString ?? "" } }
        }
    }
}
