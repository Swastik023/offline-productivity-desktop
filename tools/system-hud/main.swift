import Cocoa
import Foundation
import MachO

struct ProcessStat {
    let name: String
    let cpu: Double
    let memMB: Double
}

class HUDContentView: NSView {
    var cpuPercent: Int = 0 {
        didSet { needsDisplay = true }
    }
    var ramUsedGB: Double = 0.0 {
        didSet { needsDisplay = true }
    }
    var ramPercent: Int = 0 {
        didSet { needsDisplay = true }
    }
    var isHovered: Bool = false {
        didSet { needsDisplay = true }
    }

    var onClick: (() -> Void)?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach { removeTrackingArea($0) }
        let trackingArea = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(trackingArea)
    }

    override func mouseEntered(with event: NSEvent) {
        isHovered = true
    }

    override func mouseExited(with event: NSEvent) {
        isHovered = false
    }

    override func mouseUp(with event: NSEvent) {
        onClick?()
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        // Obsidian glass rounded pill background
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 13, yRadius: 13)
        let bgColor = isHovered 
            ? NSColor(calibratedRed: 0.08, green: 0.12, blue: 0.20, alpha: 0.95)
            : NSColor(calibratedRed: 0.04, green: 0.06, blue: 0.11, alpha: 0.90)
        bgColor.setFill()
        path.fill()

        // Border glow
        let strokeColor = isHovered
            ? NSColor(calibratedRed: 0.23, green: 0.51, blue: 0.96, alpha: 0.6)
            : NSColor(calibratedWhite: 1.0, alpha: 0.15)
        strokeColor.setStroke()
        path.lineWidth = 1.0
        path.stroke()

        // Content layout
        let text = String(format: "⚡ %d%% CPU   🧠 %.1fG (%d%%)", cpuPercent, ramUsedGB, ramPercent)
        let font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .bold)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: NSColor.white,
        ]

        let str = NSAttributedString(string: text, attributes: attrs)
        let textSize = str.size()
        let textPoint = NSPoint(
            x: (bounds.width - textSize.width) / 2.0,
            y: (bounds.height - textSize.height) / 2.0
        )
        str.draw(at: textPoint)
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSPanel!
    var hudView: HUDContentView!
    var timer: Timer?
    var prevCpuInfo: processor_info_array_t?
    var numPrevCpuInfo: mach_msg_type_number_t = 0
    var topCpuProcesses: [ProcessStat] = []
    var topMemProcesses: [ProcessStat] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        let width: CGFloat = 246
        let height: CGFloat = 34

        window = NSPanel(
            contentRect: NSRect(x: 100, y: 100, width: width, height: height),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )

        window.isFloatingPanel = true
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = true
        window.isMovableByWindowBackground = true

        let screens = NSScreen.screens
        let targetScreen = screens.first { $0 != NSScreen.main } ?? NSScreen.main ?? screens[0]
        let screenRect = targetScreen.visibleFrame
        let x = screenRect.maxX - width - 20
        let y = screenRect.maxY - height - 8
        window.setFrameOrigin(NSPoint(x: x, y: y))

        hudView = HUDContentView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        hudView.onClick = { [weak self] in
            self?.showDiagnosticsMenu()
        }

        window.contentView = hudView
        window.orderFrontRegardless()

        updateStats()
        fetchTopProcesses()

        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.updateStats()
        }

        // Process list update every 3 seconds
        Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.fetchTopProcesses()
        }
    }

    func showDiagnosticsMenu() {
        let menu = NSMenu()

        let titleItem = NSMenuItem(title: "⚡ SYSTEM RESOURCE INSPECTOR", action: nil, keyEquivalent: "")
        titleItem.attributedTitle = NSAttributedString(
            string: "⚡ SYSTEM RESOURCE INSPECTOR",
            attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .bold), .foregroundColor: NSColor.systemBlue]
        )
        menu.addItem(titleItem)
        menu.addItem(NSMenuItem.separator())

        // CPU Section
        let cpuHeader = NSMenuItem(title: "🔥 Top CPU Processes:", action: nil, keyEquivalent: "")
        cpuHeader.attributedTitle = NSAttributedString(
            string: "🔥 Top CPU Processes:",
            attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .bold)]
        )
        menu.addItem(cpuHeader)

        if topCpuProcesses.isEmpty {
            menu.addItem(NSMenuItem(title: "  Sampling processes...", action: nil, keyEquivalent: ""))
        } else {
            for p in topCpuProcesses.prefix(5) {
                let item = NSMenuItem(
                    title: String(format: "  • %-18@ %5.1f%% CPU", p.name, p.cpu),
                    action: nil,
                    keyEquivalent: ""
                )
                item.attributedTitle = NSAttributedString(
                    string: String(format: "  • %-18@ %5.1f%% CPU", p.name, p.cpu),
                    attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .medium)]
                )
                menu.addItem(item)
            }
        }

        menu.addItem(NSMenuItem.separator())

        // RAM Section
        let ramHeader = NSMenuItem(title: "🧠 Top Memory Processes:", action: nil, keyEquivalent: "")
        ramHeader.attributedTitle = NSAttributedString(
            string: "🧠 Top Memory Processes:",
            attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .bold)]
        )
        menu.addItem(ramHeader)

        if topMemProcesses.isEmpty {
            menu.addItem(NSMenuItem(title: "  Sampling memory...", action: nil, keyEquivalent: ""))
        } else {
            for p in topMemProcesses.prefix(5) {
                let memStr = p.memMB >= 1024 
                    ? String(format: "%.1f GB", p.memMB / 1024.0)
                    : String(format: "%d MB", Int(p.memMB))
                let item = NSMenuItem(
                    title: String(format: "  • %-18@ %@", p.name, memStr),
                    action: nil,
                    keyEquivalent: ""
                )
                item.attributedTitle = NSAttributedString(
                    string: String(format: "  • %-18@ %@", p.name, memStr),
                    attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .medium)]
                )
                menu.addItem(item)
            }
        }

        menu.addItem(NSMenuItem.separator())

        // System Uptime
        let uptime = ProcessInfo.processInfo.systemUptime
        let hours = Int(uptime) / 3600
        let mins = (Int(uptime) % 3600) / 60
        let uptimeItem = NSMenuItem(title: String(format: "⏱️ System Uptime: %dh %dm", hours, mins), action: nil, keyEquivalent: "")
        menu.addItem(uptimeItem)

        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "❌ Quit SystemHUD", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

        // Pop up directly under the floating HUD
        let location = NSPoint(x: 0, y: 0)
        menu.popUp(positioning: nil, at: location, in: hudView)
    }

    func updateStats() {
        let cpuUsage = getCpuUsage()
        let (ramUsedGB, _, ramPercent) = getRamUsage()

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.hudView.cpuPercent = Int(cpuUsage)
            self.hudView.ramUsedGB = ramUsedGB
            self.hudView.ramPercent = Int(ramPercent)
        }
    }

    func fetchTopProcesses() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            // Fast ps sampling for top CPU and Memory
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/ps")
            task.arguments = ["-axo", "%cpu,rss,comm", "-r"]

            let pipe = Pipe()
            task.standardOutput = pipe

            do {
                try task.run()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                task.waitUntilExit()

                if let output = String(data: data, encoding: .utf8) {
                    var cpuList: [ProcessStat] = []
                    var memList: [ProcessStat] = []

                    let lines = output.components(separatedBy: "\n")
                    for line in lines.dropFirst() {
                        let parts = line.trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
                        if parts.count == 3 {
                            let cpu = Double(parts[0]) ?? 0.0
                            let rssKB = Double(parts[1]) ?? 0.0
                            let fullPath = String(parts[2])
                            let name = (fullPath as NSString).lastPathComponent

                            if !name.isEmpty && name != "ps" && name != "grep" {
                                let stat = ProcessStat(name: name, cpu: cpu, memMB: rssKB / 1024.0)
                                cpuList.append(stat)
                                memList.append(stat)
                            }
                        }
                    }

                    cpuList.sort { $0.cpu > $1.cpu }
                    memList.sort { $0.memMB > $1.memMB }

                    DispatchQueue.main.async {
                        self?.topCpuProcesses = Array(cpuList.prefix(5))
                        self?.topMemProcesses = Array(memList.prefix(5))
                    }
                }
            } catch {
                // Ignore background sampling errors
            }
        }
    }

    func getCpuUsage() -> Double {
        var numCPUsU: natural_t = 0
        var cpuInfo: processor_info_array_t?
        var numCpuInfo: mach_msg_type_number_t = 0

        let result = host_processor_info(mach_host_self(), PROCESSOR_CPU_LOAD_INFO, &numCPUsU, &cpuInfo, &numCpuInfo)
        guard result == KERN_SUCCESS, let cpuInfo = cpuInfo else { return 0.0 }

        var totalUsage: Double = 0.0
        if let prevCpuInfo = prevCpuInfo {
            var inUse: Int32 = 0
            var total: Int32 = 0
            for i in 0..<Int32(numCPUsU) {
                let offset = Int(i) * Int(CPU_STATE_MAX)
                let user = cpuInfo[offset + Int(CPU_STATE_USER)] - prevCpuInfo[offset + Int(CPU_STATE_USER)]
                let sys = cpuInfo[offset + Int(CPU_STATE_SYSTEM)] - prevCpuInfo[offset + Int(CPU_STATE_SYSTEM)]
                let nice = cpuInfo[offset + Int(CPU_STATE_NICE)] - prevCpuInfo[offset + Int(CPU_STATE_NICE)]
                let idle = cpuInfo[offset + Int(CPU_STATE_IDLE)] - prevCpuInfo[offset + Int(CPU_STATE_IDLE)]

                inUse += user + sys + nice
                total += user + sys + nice + idle
            }
            if total > 0 {
                totalUsage = (Double(inUse) / Double(total)) * 100.0
            }

            let prevSize = vm_size_t(numPrevCpuInfo) * vm_size_t(MemoryLayout<integer_t>.stride)
            vm_deallocate(mach_task_self_, vm_address_t(UInt(bitPattern: prevCpuInfo)), prevSize)
        }

        prevCpuInfo = cpuInfo
        numPrevCpuInfo = numCpuInfo
        return min(100.0, max(0.0, totalUsage))
    }

    func getRamUsage() -> (Double, Double, Double) {
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size)
        let hostPort = mach_host_self()
        let result = withUnsafeMutablePointer(to: &stats) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(hostPort, HOST_VM_INFO64, $0, &count)
            }
        }

        guard result == KERN_SUCCESS else { return (0, 0, 0) }

        let pageSize = Double(vm_kernel_page_size)
        let active = Double(stats.active_count) * pageSize
        let wired = Double(stats.wire_count) * pageSize
        let compressed = Double(stats.compressor_page_count) * pageSize
        let usedBytes = active + wired + compressed
        let totalBytes = Double(ProcessInfo.processInfo.physicalMemory)

        let usedGB = usedBytes / 1_073_741_824.0
        let totalGB = totalBytes / 1_073_741_824.0
        let percent = (usedBytes / totalBytes) * 100.0

        return (usedGB, totalGB, percent)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
