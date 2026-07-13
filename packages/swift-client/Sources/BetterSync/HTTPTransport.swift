import Foundation

public struct HTTPTransport: SyncTransport {
  public let endpoint: URL
  public let headers: [String: String]
  public let timeout: TimeInterval

  public init(endpoint: URL, headers: [String: String] = [:], timeout: TimeInterval = 15) {
    self.endpoint = endpoint
    self.headers = headers
    self.timeout = timeout
  }

  public func send(_ request: SyncRequest) async throws -> SyncResponse {
    var urlRequest = URLRequest(url: endpoint)
    urlRequest.httpMethod = "POST"
    urlRequest.timeoutInterval = timeout
    urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
    for (name, value) in headers {
      urlRequest.setValue(value, forHTTPHeaderField: name)
    }
    urlRequest.httpBody = try JSONEncoder().encode(request)

    let (data, response) = try await URLSession.shared.data(for: urlRequest)
    guard let http = response as? HTTPURLResponse else {
      throw BetterSyncError.invalidResponse("Sync response is not HTTP")
    }
    guard (200..<300).contains(http.statusCode) else {
      let message = String(data: data, encoding: .utf8) ?? ""
      throw BetterSyncError.httpStatus(http.statusCode, message)
    }
    return try JSONDecoder().decode(SyncResponse.self, from: data)
  }
}
