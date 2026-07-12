import CoreGraphics
import ScreenCaptureKit

@available(macOS 12.3, *)
func probeScreenCaptureKitSymbols() {
    _ = SCShareableContent.self
    _ = SCStream.self
}

if #available(macOS 12.3, *) {
    probeScreenCaptureKitSymbols()
}
