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
    static let currentVersion = "0.4.30"
    @Published var server: URL?
    @Published var selection = 0
    @Published var revision = UUID()
    @Published var catalogNewCount = 0
    @Published var showWhatsNew = false
    @Published var theme: String = UserDefaults.standard.string(forKey: "theme") ?? "dark" {
        didSet { UserDefaults.standard.set(theme, forKey: "theme") }
    }
    @Published var accent: String = UserDefaults.standard.string(forKey: "accent") ?? "amber" {
        didSet { UserDefaults.standard.set(accent, forKey: "accent") }
    }
    private var latestCatalogIds: [String] = []
    private var timer: Timer?

    init() {
        if let saved = UserDefaults.standard.string(forKey: "server") { server = try? ServerAddress.parse(saved) }
        let seenVer = UserDefaults.standard.string(forKey: "whatsNewSeen")
        if let seenVer, seenVer != Self.currentVersion {
            showWhatsNew = true
        } else if seenVer == nil {
            UserDefaults.standard.set(Self.currentVersion, forKey: "whatsNewSeen")
        }
        checkCatalogLive()
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.checkCatalogLive() }
        }
    }

    func dismissWhatsNew() {
        UserDefaults.standard.set(Self.currentVersion, forKey: "whatsNewSeen")
        showWhatsNew = false
    }

    func connect(_ text: String) throws {
        let url = try ServerAddress.parse(text)
        server = url
        UserDefaults.standard.set(url.absoluteString, forKey: "server")
        revision = UUID()
        selection = 1
    }

    func markCatalogSeen() {
        if !latestCatalogIds.isEmpty {
            let existing = Set(UserDefaults.standard.stringArray(forKey: "seenCatalogIds") ?? [])
            UserDefaults.standard.set(Array(existing.union(latestCatalogIds)), forKey: "seenCatalogIds")
        }
        catalogNewCount = 0
    }

    func checkCatalogLive() {
        guard let url = URL(string: "https://raw.githubusercontent.com/yogurt5633-hub/st-app/main/catalog/catalog.json?t=\(Int(Date().timeIntervalSince1970 / 30))") else { return }
        Task {
            do {
                let (data, response) = try await URLSession.shared.data(from: url)
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let items = json["items"] as? [[String: Any]] else { return }
                let ids = items.compactMap { $0["id"] as? String }.filter { !$0.isEmpty }
                guard !ids.isEmpty else { return }
                self.latestCatalogIds = ids
                let saved = UserDefaults.standard.stringArray(forKey: "seenCatalogIds") ?? []
                if saved.isEmpty {
                    UserDefaults.standard.set(ids, forKey: "seenCatalogIds")
                    return
                }
                let seen = Set(saved)
                let fresh = ids.filter { !seen.contains($0) }.count
                if self.selection == 2 {
                    self.markCatalogSeen()
                } else {
                    self.catalogNewCount = fresh
                }
            } catch {}
        }
    }
}
struct RootView: View {
    @EnvironmentObject private var connection: Connection
    var body: some View {
        TabView(selection: $connection.selection) {
            ConnectionView().tabItem { Label("Главная", systemImage: "house") }.tag(0)
            page("Таверна", path: "").tabItem { Label("Таверна", systemImage: "bubble.left.and.bubble.right") }.tag(1)
            page("Каталог", path: "api/plugins/korrektor/app/", fragment: "tools/catalog")
                .tabItem { Label("Каталог", systemImage: "books.vertical") }
                .badge(connection.catalogNewCount)
                .tag(2)
            page("Настройки", path: "api/plugins/korrektor/app/")
                .tabItem { Label("Настройки", systemImage: "slider.horizontal.3") }
                .tag(3)
        }
        .onChange(of: connection.selection) { newValue in
            if newValue == 2 { connection.markCatalogSeen() }
        }
        .sheet(isPresented: $connection.showWhatsNew) {
            WhatsNewView()
        }
    }
    @ViewBuilder private func page(_ title: String, path: String, fragment: String? = nil) -> some View {
        if let server = connection.server {
            var components: URLComponents { var c = URLComponents(url: server.appendingPathComponent(path), resolvingAgainstBaseURL: false)!; c.fragment = fragment; return c }
            BrowserScreen(title: title, server: server, url: components.url!, theme: connection.theme, accent: connection.accent).id("\(connection.revision)-\(title)")
        } else {
            VStack(spacing: 16) {
                Image(systemName: "network").font(.largeTitle)
                Text("Сначала подключите Таверну").font(.headline)
                Button("Указать адрес") { connection.selection = 0 }.buttonStyle(.borderedProminent)
            }.padding()
        }
    }
}
struct WhatsNewView: View {
    @EnvironmentObject private var connection: Connection
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Обновление \(Connection.currentVersion) — управление таверной без лагов, конвертер, новые темы и живой каталог.")
                        .foregroundStyle(.secondary)
                }
                Section("Главные новинки") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Настройки → Таверна").font(.headline)
                        Text("Вкладки «Пресеты», «Лорбук», «Карточки», «Расширения», «Регексы» и «Антивирус» — управляйте всем содержимым запущенной SillyTavern напрямую.").font(.subheadline).foregroundStyle(.secondary)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Конвертация для SillyTavern").font(.headline)
                        Text("Во вкладке «Ещё → Конвертация для SillyTavern» превращайте JSON-карточки в PNG, извлекайте лорбуки и регексы, упаковывайте расширения в ZIP и сразу устанавливайте в таверну.").font(.subheadline).foregroundStyle(.secondary)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Отдельный «Каталог» с живой меткой и новые темы").font(.headline)
                        Text("Кнопка «Каталог» снизу показывает бейдж новинок в реальном времени. В оформлении добавлены уникальные темы «Полночь» и «Туман».").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Что нового в Тавернке")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Отлично") { connection.dismissWhatsNew() }
                }
            }
        }
    }
}
struct ConnectionView: View {
    @EnvironmentObject private var connection: Connection
    @State private var address = ""
    @State private var error: String?
    @FocusState private var addressFocused: Bool
    private func connect() {
        addressFocused = false
        do { try connection.connect(address); error = nil } catch { self.error = error.localizedDescription }
    }
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
                        .focused($addressFocused).submitLabel(.go).onSubmit(connect)
                    Button("Подключиться", action: connect).frame(minHeight: 44)
                    if let error { Text(error).foregroundStyle(.red).accessibilityLabel("Ошибка: \(error)") }
                }
                Section("Оформление") {
                    Picker("Тема", selection: $connection.theme) {
                        Text("Тёмная").tag("dark")
                        Text("Светлая").tag("light")
                        Text("Полночь").tag("midnight")
                        Text("Туман").tag("mist")
                        Text("Коричневая").tag("brown")
                        Text("Как в системе").tag("system")
                    }
                    Picker("Акцент", selection: $connection.accent) {
                        Text("Янтарь").tag("amber")
                        Text("Роза").tag("rose")
                        Text("Мята").tag("mint")
                        Text("Небо").tag("sky")
                        Text("Лаванда").tag("lavender")
                    }
                }
                Section("Как подготовить компьютер") {
                    Text("1. Запустите SillyTavern. Для вкладок «Каталог» и «Настройки» установите плагин Корректор.")
                    Text("2. В config.yaml включите listen: true и добавьте IP iPhone в whitelist. Перезапустите Таверну.")
                    Text("3. Подключите устройства к одной Wi-Fi сети (или Tailscale) и укажите здесь адрес компьютера. 127.0.0.1 на iPhone указывает на сам телефон.")
                    Text("Для внешнего сервера используйте HTTPS. Пароль вводится на странице входа или в системном окне; в адрес его добавлять не нужно.")
                }
                Section {
                    Button("Что нового в версии \(Connection.currentVersion)") { connection.showWhatsNew = true }
                    Text("Версия \(Connection.currentVersion). SillyTavern работает на компьютере или сервере; приложение на iPhone подключается к ней.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Готово") { addressFocused = false } } }
            .navigationTitle("Тавернка")
            .onAppear { if address.isEmpty { address = connection.server?.absoluteString ?? "" } }
        }
    }
}
