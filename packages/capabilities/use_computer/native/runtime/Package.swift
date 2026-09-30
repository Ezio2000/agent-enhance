// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "ComputerRuntime",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "ComputerRuntime", targets: ["ComputerRuntime"])],
    targets: [
        .executableTarget(name: "ComputerRuntime"),
        .testTarget(name: "ComputerRuntimeTests", dependencies: ["ComputerRuntime"])
    ]
)
