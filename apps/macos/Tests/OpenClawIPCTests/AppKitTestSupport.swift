import AppKit
import ApplicationServices
import Testing

@MainActor
enum AppKitTestSupport {
    /// Rendered suites share one process and must initialize AppKit only once.
    static let application: NSApplication = {
        let application = NSApplication.shared
        #expect(application.setActivationPolicy(.accessory))
        application.finishLaunching()
        return application
    }()

    static func accessibilityElements(in root: AnyObject) async throws -> [AnyObject] {
        // SwiftUI materializes its virtual accessibility children after a real client request.
        let result = await Task.detached {
            let application = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
            var windows: CFTypeRef?
            return AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windows)
        }.value
        try #require(result == .success)
        var elements: [AnyObject] = []
        var visited = Set<ObjectIdentifier>()
        func visit(_ element: AnyObject) {
            guard visited.insert(ObjectIdentifier(element)).inserted else { return }
            elements.append(element)
            for child in element.accessibilityChildren?() ?? [] {
                visit(child as AnyObject)
            }
        }
        visit(root)
        return elements
    }

    static func waitForAccessibilityElement(
        in window: NSWindow,
        description: String,
        matching find: ([AnyObject]) -> AnyObject?) async throws -> AnyObject
    {
        let deadline = ContinuousClock.now + .seconds(3)
        var observedElements: [AnyObject] = []
        repeat {
            window.contentView?.layoutSubtreeIfNeeded()
            let elements = try await self.accessibilityElements(in: window)
            observedElements = elements
            if let element = find(elements) {
                return element
            }
            try await Task.sleep(for: .milliseconds(20))
        } while ContinuousClock.now < deadline
        let toolbarItems: String = (window.toolbar?.items ?? []).map {
            "\($0.itemIdentifier.rawValue): view=\(String(describing: $0.view))"
        }.joined(separator: "\n")
        let accessibility: String = observedElements.map {
            let role = String(describing: $0.accessibilityRole?())
            let title = String(describing: $0.accessibilityTitle?())
            let label = String(describing: $0.accessibilityLabel?())
            let value: Any? = $0.accessibilityValue?()
            let identifier = String(describing: $0.accessibilityIdentifier?())
            return "role=\(role) title=\(title) label=\(label) value=\(String(describing: value)) identifier=\(identifier)"
        }.joined(separator: "\n")
        throw InteractionFailure(message: """
        The rendered window must expose \(description)
        appActive=\(NSApp.isActive) windowVisible=\(window.isVisible) windowKey=\(window.isKeyWindow)
        Toolbar items:
        \(toolbarItems)
        Accessibility elements:
        \(accessibility)
        """)
    }

    static func pressMenu(
        _ button: AnyObject,
        in window: NSWindow,
        file: StaticString = #fileID,
        line: UInt = #line,
        inspect: @escaping (NSMenu) throws -> Void) async throws
    {
        let role: NSAccessibility.Role? = button.accessibilityRole?()
        let identifier: String? = button.accessibilityIdentifier?()
        let label: String? = button.accessibilityLabel?()
        let title: String? = button.accessibilityTitle?()
        guard let role else { throw InteractionFailure(message: "The menu control has no accessibility role") }
        let identity = AppKitTestAXMenu.Identity(
            role: role.rawValue,
            identifier: identifier.flatMap { $0.isEmpty ? nil : $0 },
            label: label.flatMap { $0.isEmpty ? nil : $0 },
            title: title.flatMap { $0.isEmpty ? nil : $0 })
        guard identity.identifier != nil || identity.label != nil || identity.title != nil else {
            throw InteractionFailure(message: "The menu control has no identifying accessibility attributes")
        }
        let previousIdentifier = window.accessibilityIdentifier()
        let windowIdentifier = "openclaw-menu-test-\(UUID().uuidString)"
        window.setAccessibilityIdentifier(windowIdentifier)
        defer { window.setAccessibilityIdentifier(previousIdentifier) }
        guard window.accessibilityIdentifier() == windowIdentifier else {
            throw InteractionFailure(message: "The fixture window did not retain its accessibility identifier")
        }
        let tracking = AppKitTestMenuTracking(inspect: inspect)
        tracking.start()
        defer { tracking.stop() }
        let request = AppKitTestAXMenu.Request(
            processID: ProcessInfo.processInfo.processIdentifier,
            windowIdentifier: windowIdentifier,
            control: identity,
            deadline: tracking.expiresAt)
        let result = AppKitTestAXMenu.perform(request)
        if result.action != nil { await tracking.waitForCompletion() }
        let completed = tracking.observed && tracking.inspectionCompleted && !tracking.timedOut
        print("""
        Menu interaction at \(file):\(line)
        actions=\(result.advertisedActions) action=\(String(describing: result.action)) AXError=\(String(describing: result.status)) resolutionError=\(String(describing: result.error))
        observed=\(tracking.observed) inspected=\(tracking.inspectionCompleted) timedOut=\(tracking.timedOut) error=\(String(describing: tracking.error))
        control=\(identity) windowIdentifier=\(windowIdentifier) appActive=\(NSApp.isActive) visible=\(window.isVisible) key=\(window.isKeyWindow)
        """)
        if let error = tracking.error { throw error }
        try Task.checkCancellation()
        // AX can report cannotComplete after modal processing; inspection still owns completion.
        let accepted = result.status == AXError.success.rawValue || result.status == AXError.cannotComplete.rawValue
        guard accepted, completed else {
            throw InteractionFailure(message: result.error ??
                "The native menu inspection must complete before its tracking deadline")
        }
    }

    private struct InteractionFailure: LocalizedError {
        let message: String
        var errorDescription: String? {
            self.message
        }
    }
}

// Same-process AX actions may invoke SwiftUI handlers synchronously.
@MainActor
private enum AppKitTestAXMenu {
    struct Identity {
        let role: String
        let identifier: String?
        let label: String?
        let title: String?
    }

    struct Request {
        let processID: Int32
        let windowIdentifier: String
        let control: Identity
        let deadline: ContinuousClock.Instant
    }

    struct Result {
        var advertisedActions: [String] = []
        var action: String?
        var status: Int32?
        var error: String?
    }

    private struct Failure: Error {
        let message: String
    }

    static func perform(_ request: Request) -> Result {
        var result = Result()
        do {
            try self.checkCurrent(request)
            let application = AXUIElementCreateApplication(request.processID)
            let windows = try self.elements(application, attribute: kAXWindowsAttribute)
            let matches = try windows.filter {
                try self.text($0, attribute: kAXIdentifierAttribute) == request.windowIdentifier
            }
            guard matches.count == 1, let window = matches.first else {
                throw Failure(message: "Expected one fixture AX window, found \(matches.count)")
            }
            var pending = [window]
            var visited: [AXUIElement] = []
            var controls: [AXUIElement] = []
            while let element = pending.popLast() {
                try self.checkCurrent(request)
                guard !visited.contains(where: { CFEqual($0, element) }) else { continue }
                visited.append(element)
                if try self.matches(element, identity: request.control) { controls.append(element) }
                try pending.append(contentsOf: self.elements(element, attribute: kAXChildrenAttribute, optional: true))
            }
            guard controls.count == 1, let control = controls.first else {
                throw Failure(message: "Expected one matching AX control, found \(controls.count)")
            }
            var actions: CFArray?
            let actionStatus = AXUIElementCopyActionNames(control, &actions)
            guard actionStatus == .success, let actions else {
                throw Failure(message: "Copy AX actions failed: \(actionStatus.rawValue)")
            }
            result.advertisedActions = try self.values(actions).map { try self.string($0) }
            let menuActions: [String] = [kAXPressAction, kAXShowMenuAction]
            guard let action = menuActions.first(where: { result.advertisedActions.contains($0) }) else {
                throw Failure(message: "The control advertises no Press or Show Menu action")
            }
            let controlWindow = try self.element(self.attribute(control, name: kAXWindowAttribute))
            guard CFEqual(controlWindow, window),
                  try self.text(window, attribute: kAXIdentifierAttribute) == request.windowIdentifier,
                  try self.matches(control, identity: request.control)
            else { throw Failure(message: "The AX control no longer belongs to the fixture window") }
            try self.checkCurrent(request)
            result.action = action
            result.status = AXUIElementPerformAction(control, action as CFString).rawValue
        } catch let failure as Failure {
            result.error = failure.message
        } catch {
            result.error = String(describing: error)
        }
        return result
    }

    private static func checkCurrent(_ request: Request) throws {
        try Task.checkCancellation()
        guard ContinuousClock.now < request.deadline else {
            throw Failure(message: "The menu interaction deadline expired before AX dispatch")
        }
    }

    private static func matches(_ element: AXUIElement, identity: Identity) throws -> Bool {
        guard try self.text(element, attribute: kAXRoleAttribute) == identity.role else { return false }
        for (attribute, expected) in [
            (kAXIdentifierAttribute, identity.identifier),
            (kAXDescriptionAttribute, identity.label),
            (kAXTitleAttribute, identity.title),
        ] {
            if let expected, try self.text(element, attribute: attribute) != expected { return false }
        }
        return true
    }

    private static func attribute(_ element: AXUIElement, name: String, optional: Bool = false) throws -> CFTypeRef? {
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        if optional, status == .attributeUnsupported || status == .noValue { return nil }
        guard status == .success, let value else {
            throw Failure(message: "Read \(name) failed: \(status.rawValue)")
        }
        return value
    }

    private static func text(_ element: AXUIElement, attribute: String) throws -> String? {
        guard let value = try self.attribute(element, name: attribute, optional: true) else { return nil }
        return try self.string(value)
    }

    private static func string(_ value: CFTypeRef) throws -> String {
        guard CFGetTypeID(value) == CFStringGetTypeID(), let string = value as? String else {
            throw Failure(message: "Expected an AX string")
        }
        return string
    }

    private static func values(_ value: CFTypeRef) throws -> [CFTypeRef] {
        guard CFGetTypeID(value) == CFArrayGetTypeID(), let values = value as? [CFTypeRef] else {
            throw Failure(message: "Expected an AX array")
        }
        return values
    }

    private static func element(_ value: CFTypeRef?) throws -> AXUIElement {
        guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else {
            throw Failure(message: "Expected an AX element")
        }
        // This is an AX API result validated by CF type, never an in-process AppKit object.
        return unsafeDowncast(value, to: AXUIElement.self)
    }

    private static func elements(
        _ element: AXUIElement,
        attribute: String,
        optional: Bool = false) throws -> [AXUIElement]
    {
        guard let value = try self.attribute(element, name: attribute, optional: optional) else { return [] }
        return try self.values(value).map { try self.element($0) }
    }
}

@MainActor
private final class AppKitTestMenuTracking: NSObject {
    private static let timeout: TimeInterval = 3
    let inspect: (NSMenu) throws -> Void
    let expiresAt: ContinuousClock.Instant
    private(set) var observed = false
    private(set) var inspectionCompleted = false
    private(set) var timedOut = false
    private(set) var error: Error?
    private var menu: NSMenu?
    private var inspection: Timer?
    private var deadline: Timer?
    private var completion: CheckedContinuation<Void, Never>?

    init(inspect: @escaping (NSMenu) throws -> Void) {
        self.inspect = inspect
        self.expiresAt = ContinuousClock.now + .seconds(Self.timeout)
    }

    func start() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(self.beganTracking(_:)),
            name: NSMenu.didBeginTrackingNotification, object: nil)
        let deadline = Timer(
            timeInterval: Self.timeout,
            target: self,
            selector: #selector(self.expire),
            userInfo: nil,
            repeats: false)
        self.deadline = deadline
        for mode in [RunLoop.Mode.eventTracking, .common] {
            RunLoop.main.add(deadline, forMode: mode)
        }
    }

    func waitForCompletion() async {
        guard !self.inspectionCompleted, !self.timedOut else { return }
        await withCheckedContinuation { self.completion = $0 }
    }

    @objc private func beganTracking(_ notification: Notification) {
        guard !self.observed, let menu = notification.object as? NSMenu else { return }
        self.observed = true
        self.menu = menu
        guard !self.timedOut, ContinuousClock.now < self.expiresAt else {
            self.expire()
            return
        }
        // AppKit tracks menus in a nested run loop; inspect and cancel in that mode too.
        let inspection = Timer(
            timeInterval: 0,
            target: self,
            selector: #selector(self.inspectMenu),
            userInfo: nil,
            repeats: false)
        self.inspection = inspection
        for mode in [RunLoop.Mode.eventTracking, .common] {
            RunLoop.main.add(inspection, forMode: mode)
        }
    }

    @objc private func inspectMenu() {
        guard let menu = self.menu else { return }
        guard !self.timedOut, ContinuousClock.now < self.expiresAt else {
            self.expire()
            return
        }
        defer {
            self.inspectionCompleted = true
            self.deadline?.invalidate()
            menu.cancelTrackingWithoutAnimation()
            self.resumeWaiter()
        }
        do { try self.inspect(menu) } catch { self.error = error }
    }

    @objc private func expire() {
        guard !self.inspectionCompleted else { return }
        self.timedOut = true
        self.menu?.cancelTrackingWithoutAnimation()
        self.resumeWaiter()
    }

    func stop() {
        self.inspection?.invalidate()
        self.deadline?.invalidate()
        self.menu?.cancelTrackingWithoutAnimation()
        NotificationCenter.default.removeObserver(self)
        self.resumeWaiter()
    }

    private func resumeWaiter() {
        let completion = self.completion
        self.completion = nil
        completion?.resume()
    }
}
