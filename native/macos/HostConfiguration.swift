import AppKit

struct HostConfiguration {
    let root: URL
    let python: URL
    let port: Int
    let settings: String?
    let path: String
    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    /// Read trusted build-time settings; no webpage may select an executable or checkout.
    /// @param bundle: Native app bundle. @pre Built by build_macos_app.py.
    /// @post No IO mutation. @return Configuration. @throws NSError: Missing/invalid configuration.
    init(bundle: Bundle = .main) throws {
        guard let root = bundle.object(forInfoDictionaryKey: "WorkbenchRoot") as? String,
              let python = bundle.object(forInfoDictionaryKey: "WorkbenchPython") as? String,
              let port = bundle.object(forInfoDictionaryKey: "WorkbenchPort") as? Int,
              (1...65535).contains(port), root.hasPrefix("/"), python.hasPrefix("/") else {
            throw NSError(domain: "WorkbenchHost", code: 1, userInfo: [NSLocalizedDescriptionKey: "This app has no valid local server configuration. Rebuild it from the Workbench checkout."])
        }
        self.root = URL(fileURLWithPath: root)
        self.python = URL(fileURLWithPath: python)
        self.port = port
        self.settings = bundle.object(forInfoDictionaryKey: "WorkbenchSettings") as? String
        self.path = bundle.object(forInfoDictionaryKey: "WorkbenchPath") as? String ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Library/TeX/texbin"
    }

    /// Restrict embedded top-level navigation to the configured local server.
    /// @param url: Proposed destination. @pre None. @post No state change.
    /// @return Bool: True only for exact loopback HTTP origin. @throws None.
    func contains(_ url: URL) -> Bool {
        url.scheme == "http" && url.host == "127.0.0.1" && url.port == port && url.user == nil && url.password == nil
    }
}
