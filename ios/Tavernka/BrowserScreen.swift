import SwiftUI
import WebKit

@MainActor
final class BrowserModel: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let webView: WKWebView
    let server: URL
    let initialURL: URL
    @Published var loading = false
    @Published var error: String?
    @Published var sharedFile: SharedFile?
    private var downloads: [ObjectIdentifier: URL] = [:]
    init(server: URL, url: URL) {
        self.server = server; self.initialURL = url
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self; webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.load(URLRequest(url: url))
    }
    func reload() { error = nil; if webView.url == nil { webView.load(URLRequest(url: initialURL)) } else { webView.reload() } }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { loading = true; error = nil }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loading = false }
    func fail(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        loading = false
        self.error = "Не удалось открыть Таверну. Проверьте адрес, запуск сервера и разрешение доступа к локальной сети в настройках iPhone.\n\(error.localizedDescription)"
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { loading = false; error = "Страница была выгружена из памяти. Нажмите «Повторить»." }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        // Frames keep normal WebKit isolation. Only the chosen server can replace a main page.
        if action.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
        if ServerAddress.sameOrigin(url, server) || (action.shouldPerformDownload && url.scheme == "blob") {
            if action.shouldPerformDownload { decisionHandler(.download) }
            else if action.targetFrame == nil { webView.load(action.request); decisionHandler(.cancel) }
            else { decisionHandler(.allow) }
        } else {
            decisionHandler(.cancel)
            if action.navigationType == .linkActivated && ["https", "http"].contains(url.scheme ?? "") {
                let alert = UIAlertController(title: "Открыть ссылку в браузере?", message: url.host, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "Отмена", style: .cancel))
                alert.addAction(UIAlertAction(title: "Открыть", style: .default) { _ in UIApplication.shared.open(url) })
                present(alert)
            }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let status = (response.response as? HTTPURLResponse)?.statusCode, status >= 400, response.isForMainFrame {
            loading = false
            error = status == 404 ? "Страница не найдена. Для Корректора и Каталога установите плагин и перезапустите SillyTavern." : "Сервер ответил с кодом \(status). Проверьте вход и настройки доступа SillyTavern."
            decisionHandler(.cancel); return
        }
        let attachment = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().contains("attachment") == true
        decisionHandler(response.canShowMIMEType && !attachment ? .allow : .download)
    }
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let method = challenge.protectionSpace.authenticationMethod
        guard [NSURLAuthenticationMethodHTTPBasic, NSURLAuthenticationMethodHTTPDigest].contains(method) else {
            completionHandler(.performDefaultHandling, nil); return // Never bypass certificate checks.
        }
        guard challenge.previousFailureCount < 3 else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        let alert = UIAlertController(title: "Вход в Таверну", message: challenge.protectionSpace.host, preferredStyle: .alert)
        alert.addTextField { $0.placeholder = "Логин"; $0.autocapitalizationType = .none; $0.autocorrectionType = .no }
        alert.addTextField { $0.placeholder = "Пароль"; $0.isSecureTextEntry = true }
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(.cancelAuthenticationChallenge, nil) })
        alert.addAction(UIAlertAction(title: "Войти", style: .default) { _ in completionHandler(.useCredential, URLCredential(user: alert.textFields?[0].text ?? "", password: alert.textFields?[1].text ?? "", persistence: .forSession)) })
        if !present(alert) { completionHandler(.cancelAuthenticationChallenge, nil) }
    }
    @discardableResult private func present(_ alert: UIAlertController) -> Bool {
        guard var controller = webView.window?.rootViewController else { return false }
        while let next = controller.presentedViewController { controller = next }
        controller.present(alert, animated: true); return true
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: "Тавернка", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        if !present(alert) { completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: "Тавернка", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "Продолжить", style: .default) { _ in completionHandler(true) })
        if !present(alert) { completionHandler(false) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: "Тавернка", message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        if !present(alert) { completionHandler(nil) }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let filename = (suggestedFilename as NSString).lastPathComponent
            let url = directory.appendingPathComponent(filename.isEmpty || filename == "." || filename == ".." ? "download" : filename)
            downloads[ObjectIdentifier(download)] = url; completionHandler(url)
        } catch { completionHandler(nil); fail(error) }
    }
    func downloadDidFinish(_ download: WKDownload) {
        loading = false
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) { sharedFile = SharedFile(url: url) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        fail(error)
    }
}
struct SharedFile: Identifiable { let id = UUID(); let url: URL }
struct BrowserScreen: View {
    let title: String
    @StateObject private var model: BrowserModel
    init(title: String, server: URL, url: URL) {
        self.title = title
        _model = StateObject(wrappedValue: BrowserModel(server: server, url: url))
    }
    var body: some View {
        NavigationStack {
            ZStack {
                WebPage(webView: model.webView)
                if let error = model.error {
                    VStack(spacing: 16) { Text(error).multilineTextAlignment(.center); Button("Повторить") { model.reload() }.buttonStyle(.borderedProminent) }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity).background(.background)
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) { if model.loading { ProgressView().frame(maxWidth: .infinity).padding(4) } }
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItemGroup(placement: .navigationBarTrailing) {
                Button { if model.webView.canGoBack { model.webView.goBack() } } label: { Image(systemName: "chevron.backward") }.accessibilityLabel("Назад")
                Button { model.reload() } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Обновить страницу")
            } }
            .sheet(item: $model.sharedFile) { file in ShareSheet(url: file.url) }
        }
    }
}
struct WebPage: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        return controller
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
