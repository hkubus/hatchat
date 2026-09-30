// swift-tools-version:6.0
//
// Everything in the iOS app that is not a view: the wire models, the SSE frame
// parser, the transcript view-model, the HTTP client and the chat state
// machine. None of it imports SwiftUI or UIKit, so it builds and tests on Linux
// as well as on Apple platforms — `swift test` from this directory runs the
// same checks CI runs, without Xcode.

import PackageDescription

let package = Package(
    name: "HatKit",
    platforms: [.iOS(.v18), .macOS(.v14)],
    products: [
        .library(name: "HatKit", targets: ["HatKit"]),
    ],
    targets: [
        .target(name: "HatKit", swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "HatKitTests", dependencies: ["HatKit"], swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
