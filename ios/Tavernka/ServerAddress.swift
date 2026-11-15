import Foundation

enum ServerAddress {
    static func parse(_ text: String) throws -> URL {
        guard let parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), ["https", "http"].contains(scheme),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.port == nil || (1...65535).contains(parts.port!),
              let url = parts.url else { throw AddressError.invalid }
        if scheme == "http" && !isLocal(host) { throw AddressError.httpsRequired }
        return url
    }
    static func isLocal(_ host: String) -> Bool {
        let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if h == "localhost" || h.hasSuffix(".local") || h == "::1" { return true }
        if h.contains(":") { return h.hasPrefix("fc") || h.hasPrefix("fd") || h.hasPrefix("fe80:") }
        let parts = h.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return false }
        return octets[0] == 10 || octets[0] == 127 ||
            (octets[0] == 192 && octets[1] == 168) ||
            (octets[0] == 172 && (16...31).contains(octets[1])) ||
            (octets[0] == 100 && (64...127).contains(octets[1])) ||
            (octets[0] == 169 && octets[1] == 254)
    }
    static func sameOrigin(_ url: URL, _ server: URL) -> Bool {
        func port(_ url: URL) -> Int { url.port ?? (url.scheme == "https" ? 443 : 80) }
        return url.scheme?.lowercased() == server.scheme?.lowercased() &&
            url.host?.lowercased() == server.host?.lowercased() && port(url) == port(server)
    }
    enum AddressError: LocalizedError {
        case invalid, httpsRequired
        var errorDescription: String? {
            switch self {
            case .invalid: return "Укажите адрес сервера с http:// или https:// и портом, без пароля, пути и параметров."
            case .httpsRequired: return "Для внешнего сервера нужен HTTPS. HTTP доступен в локальной или частной сети."
            }
        }
    }
}
