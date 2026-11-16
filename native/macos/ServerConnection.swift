import Foundation
import Darwin

enum ServerHealth { case ready, offline, occupied }

private struct LocalResponse {
    let status: Int
    let bytes: Data
}

/// Build one actionable native connection error without returning a response token/body.
/// @param message: Public recovery text. @pre No credentials in message.
/// @post No state change. @return Error. @throws None.
private func connectionError(_ message: String) -> Error {
    NSError(domain: "WorkbenchHost", code: 3, userInfo: [NSLocalizedDescriptionKey: message])
}

/// Distinguish a closed port from a server that still owns its listener while draining work.
/// @param port: Trusted loopback port. @pre Worker/delegate queue, 1...65535.
/// @post Only a short connection probe runs; descriptor always closes.
/// @return Bool: True only on definite ECONNREFUSED. @throws None; unknown failures remain occupied.
private func loopbackConnectionIsRefused(_ port: Int) -> Bool {
    let descriptor = socket(AF_INET, SOCK_STREAM, 0)
    guard descriptor >= 0 else { return false }
    defer { close(descriptor) }
    guard fcntl(descriptor, F_SETFL, O_NONBLOCK) != -1 else { return false }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = UInt16(port).bigEndian
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    if result == 0 { return false }
    if errno == ECONNREFUSED { return true }
    guard errno == EINPROGRESS else { return false }
    var descriptorState = pollfd(fd: descriptor, events: Int16(POLLOUT), revents: 0)
    guard poll(&descriptorState, 1, 200) > 0 else { return false }
    var socketError: Int32 = 0
    var size = socklen_t(MemoryLayout<Int32>.size)
    guard getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &socketError, &size) == 0 else { return false }
    return socketError == ECONNREFUSED
}

final class ServerConnection {
    private let config: HostConfiguration
    private var working = false

    /// Own a bounded transport and single native lifecycle action at a time.
    /// @param config: Trusted configuration. @pre Main thread.
    /// @post No process/network operation begins. @return Connection. @throws None.
    init(config: HostConfiguration) { self.config = config }

    /// Check identity without changing the loaded editor or starting/stopping a process.
    /// @param completion: Main-queue callback. @pre Main thread.
    /// @post A timeout/listening draining server never counts as offline.
    /// @return None. @throws None.
    func check(_ completion: @escaping (ServerHealth) -> Void) {
        let port = config.port
        request("api/health") { result in
            var health: ServerHealth = .occupied
            if case .success(let response) = result,
               response.status == 200,
               let body = try? JSONSerialization.jsonObject(with: response.bytes) as? [String: Any],
               body.count == 3, body["application"] as? String == "research-workbench",
               body["protocol"] as? Int == 1, body["status"] as? String == "ready" {
                health = .ready
            } else if loopbackConnectionIsRefused(port) { health = .offline }
            DispatchQueue.main.async { completion(health) }
        }
    }

    /// Run one fixed local HTTP operation with bounded bytes, time and no redirects/proxies.
    /// @param path,method,token,completion: Trusted API suffix, verb, optional token and delegate-queue result.
    /// @pre Native code chooses path; body is fixed empty JSON for POST.
    /// @post No credential is logged; connection/session is released after completion.
    /// @return None. @throws None; errors are delivered once.
    private func request(_ path: String, method: String = "GET", token: String? = nil,
                         completion: @escaping (Result<LocalResponse, Error>) -> Void) {
        var request = URLRequest(url: config.baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let token = token {
            request.setValue(token, forHTTPHeaderField: "X-PDF-Token")
            request.setValue(config.baseURL.absoluteString, forHTTPHeaderField: "Origin")
        }
        if method == "POST" {
            request.httpBody = Data("{}".utf8)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        LocalRequest(request: request, completion: completion).start()
    }

    /// Launch from a trusted native action, reusing existing healthy servers.
    /// @param completion: Main-queue result. @pre Main thread.
    /// @post One bounded helper owns startup/cleanup; ready servers survive app close.
    /// @return Bool: New attempt began. @throws None; failures go to completion.
    @discardableResult func launch(_ completion: @escaping (Result<Void, Error>) -> Void) -> Bool {
        guard !working else { return false }
        working = true
        let config = self.config
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            let pipe = Pipe()
            process.executableURL = config.python
            process.currentDirectoryURL = config.root
            process.arguments = ["-m", "research_workbench.native_host.recovery", "--root", config.root.path,
                                 "--port", String(config.port), "--timeout", "15"]
            if let settings = config.settings { process.arguments! += ["--settings", settings] }
            var environment = ProcessInfo.processInfo.environment
            environment["PATH"] = config.path
            environment["PYTHONUNBUFFERED"] = "1"
            process.environment = environment
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice
            let result: Result<Void, Error>
            do {
                try process.run()
                let done = DispatchSemaphore(value: 0)
                process.terminationHandler = { _ in done.signal() }
                if process.isRunning && done.wait(timeout: .now() + 25) == .timedOut {
                    if process.isRunning { process.terminate() }
                    _ = done.wait(timeout: .now() + 5)
                    throw connectionError("The launcher took too long. Its startup was canceled. Try Launch Server again.")
                }
                process.waitUntilExit()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                if process.terminationStatus == 0 && body?["ok"] as? Bool == true { result = .success(()) }
                else { throw connectionError(body?["error"] as? String ?? "The local launcher failed. Check that the Workbench folder and configured Python still exist, then rebuild the app if they moved.") }
            } catch { result = .failure(error) }
            DispatchQueue.main.async { self.working = false; completion(result) }
        }
        return true
    }

    /// Stop a verified shared backend through its current token, then verify the listener closed.
    /// @param completion: Main-queue success/failure. @pre User confirmed shared impact; main thread.
    /// @post No process is signaled; active backend requests drain normally; page state is untouched.
    /// @return Bool: New stop began. @throws None; unavailable/old/auth/timeout failures are reported once.
    @discardableResult func stop(_ completion: @escaping (Result<Void, Error>) -> Void) -> Bool {
        guard !working else { return false }
        working = true
        check { health in
            guard health == .ready else {
                self.finishStop(.failure(connectionError("The verified Workbench server is unavailable. Check its status and try again.")), completion)
                return
            }
            self.request("api/server/status") { result in
                guard case .success(let response) = result, response.status == 200,
                      let body = try? JSONSerialization.jsonObject(with: response.bytes) as? [String: Any],
                      body["application"] as? String == "research-workbench", body["protocol"] as? Int == 1,
                      let token = body["token"] as? String, !token.isEmpty, token.count <= 512 else {
                    self.finishStop(.failure(connectionError("This server could not provide shutdown support. Restart it with the current launcher, then try again.")), completion)
                    return
                }
                self.request("api/server/shutdown", method: "POST", token: token) { result in
                    guard case .success(let response) = result, response.status == 202,
                          let body = try? JSONSerialization.jsonObject(with: response.bytes) as? [String: Any],
                          body["stopping"] as? Bool == true else {
                        self.finishStop(.failure(connectionError("The server did not accept the shutdown request. Your editor has been kept. Try Stop Server again.")), completion)
                        return
                    }
                    DispatchQueue.main.async { self.waitUntilStopped(deadline: Date().addingTimeInterval(15), completion) }
                }
            }
        }
        return true
    }

    /// Wait for definite refusal, treating health timeouts during request draining as still occupied.
    /// @param deadline,completion: Absolute verification bound and main-queue result.
    /// @pre A stop request was accepted; main thread. @post No reload/restart/forced termination.
    /// @return None. @throws None; timeout retains safe retry and reports unfinished shutdown.
    private func waitUntilStopped(deadline: Date, _ completion: @escaping (Result<Void, Error>) -> Void) {
        check { health in
            if health == .offline { self.finishStop(.success(()), completion) }
            else if Date() >= deadline {
                self.finishStop(.failure(connectionError("The server is still stopping or could not stop. Active work may still be finishing. Try again shortly.")), completion)
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitUntilStopped(deadline: deadline, completion) }
            }
        }
    }

    /// Complete the native single-flight action on the UI queue.
    /// @param result,completion: Final stop outcome and callback. @pre Any queue.
    /// @post New lifecycle actions may begin. @return None. @throws None.
    private func finishStop(_ result: Result<Void, Error>, _ completion: @escaping (Result<Void, Error>) -> Void) {
        DispatchQueue.main.async { self.working = false; completion(result) }
    }
}

private final class LocalRequest: NSObject, URLSessionDataDelegate {
    private let request: URLRequest
    private let completion: (Result<LocalResponse, Error>) -> Void
    private var bytes = Data()
    private var response: HTTPURLResponse?
    private var transport: URLSession?
    private var valid = true

    /// Prepare one bounded native HTTP request without beginning IO.
    /// @param request,completion: Fixed local request and delegate-queue callback.
    /// @pre Native trusted caller. @post No IO. @return Request. @throws None.
    init(request: URLRequest, completion: @escaping (Result<LocalResponse, Error>) -> Void) {
        self.request = request; self.completion = completion
    }

    /// Start a 2-second request with 4096-byte response cap; retain until completion.
    /// @param None. @pre Called once. @post One request active. @return None. @throws None.
    func start() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 1.5
        config.timeoutIntervalForResource = 2
        config.connectionProxyDictionary = [:]
        transport = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        transport!.dataTask(with: request).resume()
    }

    /// Refuse redirects, including those returned by an unrelated local service.
    /// @param session,task,response,request,completionHandler: Redirect inputs.
    /// @pre Active task. @post Redirect rejected. @return None. @throws None.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }

    /// Accept only a bounded same-endpoint response, retaining status for the operation owner.
    /// @param session,dataTask,response,completionHandler: Response inputs.
    /// @pre Active task. @post Invalid headers cancel transport. @return None. @throws None.
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        self.response = response as? HTTPURLResponse
        valid = self.response != nil && response.url == request.url
            && response.expectedContentLength >= 0 && response.expectedContentLength <= 4096
        completionHandler(valid ? .allow : .cancel)
    }

    /// Accumulate at most 4096 bytes, canceling oversized bodies before parsing.
    /// @param session,dataTask,data: Next bytes. @pre Active task.
    /// @post Stored bytes remain bounded. @return None. @throws None.
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if bytes.count + data.count > 4096 { valid = false; dataTask.cancel() }
        else { bytes.append(data) }
    }

    /// Deliver once on the delegate queue and release the session/delegate lifetime cycle.
    /// @param session,task,error: Completed request. @pre Task ended.
    /// @post Session invalidates and callback runs once. @return None. @throws None.
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let result: Result<LocalResponse, Error>
        if valid, error == nil, let response = response { result = .success(LocalResponse(status: response.statusCode, bytes: bytes)) }
        else { result = .failure(error ?? connectionError("The local server returned an invalid response.")) }
        session.finishTasksAndInvalidate(); transport = nil
        completion(result)
    }
}
