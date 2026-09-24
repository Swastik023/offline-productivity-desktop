import Cocoa
import Foundation
import MachO
import IOKit
import IOKit.ps

enum DisplayStyle: String {
    case minimalCpuRam = "minimalCpuRam" // ⚡ 24%  🧠 16.2G (Space Saver)
    case proSpeed = "proSpeed"           // ⚡ 24%  🧠 16.2G  ▲ 3.8M  ▼ 1.2M
    case cyberMatrix = "cyberMatrix"     // ⚡ 24% [■■□□]  🧠 16.2G [■■■□]  ▲ 3.8M
    case compactSpeed = "compactSpeed"   // ⚡ 24%  🧠 16.2G (67%)  ▲ 3.8M
}

struct ProcessStat {
    let pid: Int32
    let name: String
    let rawName: String
    let cpu: Double
    let memMB: Double
    let isProtected: Bool
}

class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var statusItem: NSStatusItem!
    var timer: Timer?
    var prevCpuInfo: processor_info_array_t?
    var numPrevCpuInfo: mach_msg_type_number_t = 0
    var menu: NSMenu!

    var cpuTotalItem: NSMenuItem!
    var ramTotalItem: NSMenuItem!
    var gpuTotalItem: NSMenuItem!
    var netSpeedItem: NSMenuItem!
    var systemStatusItem: NSMenuItem!

    var cpuSubMenu: NSMenu!
    var ramSubMenu: NSMenu!
    var cpuHeaderItem: NSMenuItem!
    var ramHeaderItem: NSMenuItem!

    var topCpuProcesses: [ProcessStat] = []
    var topMemProcesses: [ProcessStat] = []

    // Rolling Network telemetry
    var prevNetBytesIn: UInt64 = 0
    var prevNetBytesOut: UInt64 = 0
    var prevNetTime: TimeInterval = 0
    var rollingUploadSamples: [Double] = []
    var rollingDownloadSamples: [Double] = []

    var eCoreUsage: Double = 0.0
    var pCoreUsage: Double = 0.0
    var totalCpuUsage: Double = 0.0

    var currentStyle: DisplayStyle = .proSpeed

    // Protected system daemons that must never be killed
    let protectedSystemProcesses: Set<String> = [
        "WindowServer", "kernel_task", "launchd", "loginwindow",
        "coreaudiod", "cameracaptured", "powerd", "diskarbitrationd",
        "securityd", "syspolicyd", "tccd", "ControlCenter", "SystemHUD",
        "ResourceMonitor", "Dock", "Finder"
    ]

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let savedStyle = UserDefaults.standard.string(forKey: "TechieStyle"),
           let style = DisplayStyle(rawValue: savedStyle) {
            currentStyle = style
        }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "⚡ 00% [□□□□]  🧠 00G [□□□□]"
            button.font = NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .bold)
        }

        let (ibytes, obytes) = getNetworkBytes()
        prevNetBytesIn = ibytes
        prevNetBytesOut = obytes
        prevNetTime = Date().timeIntervalSince1970

        buildMenu()
        updateStats()
        fetchTopProcesses()

        // 1.5-second high-efficiency telemetry
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.updateStats()
        }

        // Process telemetry every 3 seconds
        Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.fetchTopProcesses()
        }
    }

    func makeMiniBar(percent: Double, totalBars: Int = 4) -> String {
        let filled = Int(round((percent / 100.0) * Double(totalBars)))
        let clamped = max(0, min(totalBars, filled))
        return "[" + String(repeating: "■", count: clamped) + String(repeating: "□", count: totalBars - clamped) + "]"
    }

    func makeProgressBarText(percent: Double, totalBlocks: Int = 10) -> String {
        let filled = Int(round((percent / 100.0) * Double(totalBlocks)))
        let clamped = max(0, min(totalBlocks, filled))
        return "[" + String(repeating: "■", count: clamped) + String(repeating: "□", count: totalBlocks - clamped) + "]"
    }

    func cleanProcessName(_ raw: String) -> String {
        if raw.contains("Electron Helper") {
            return "Super Productivity"
        } else if raw.contains("Google Chrome Helper") {
            return "Chrome (Renderer)"
        } else if raw.contains("Antigravity IDE Helper") {
            return "Antigravity IDE"
        } else if raw.contains("language_server") {
            return "Antigravity LS"
        } else if raw == "OBS" {
            return "OBS Studio"
        }
        return raw
    }

    @objc func dummyAction() {}

    func createInfoItem(title: String, color: NSColor = .white, isBold: Bool = false) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(dummyAction), keyEquivalent: "")
        item.target = self
        item.attributedTitle = NSAttributedString(
            string: title,
            attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: isBold ? .bold : .medium),
                .foregroundColor: color
            ]
        )
        return item
    }

    func buildMenu() {
        menu = NSMenu()
        menu.delegate = self

        // Banner Header
        let bannerItem = NSMenuItem(title: "⚡ APPLE M5 COMMAND CENTER // 10-CORE ARCH", action: #selector(dummyAction), keyEquivalent: "")
        bannerItem.target = self
        bannerItem.attributedTitle = NSAttributedString(
            string: "⚡ APPLE M5 COMMAND CENTER // 10-CORE ARCH",
            attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .bold),
                .foregroundColor: NSColor(calibratedRed: 0.22, green: 0.74, blue: 0.98, alpha: 1.0)
            ]
        )
        menu.addItem(bannerItem)
        menu.addItem(NSMenuItem.separator())

        // Hardware Gauges (Compact & Clean)
        cpuTotalItem = createInfoItem(title: "⚡ CPU   Calculating...")
        menu.addItem(cpuTotalItem)

        ramTotalItem = createInfoItem(title: "🧠 RAM   Calculating...")
        menu.addItem(ramTotalItem)

        gpuTotalItem = createInfoItem(title: "🎮 GPU   Calculating...")
        menu.addItem(gpuTotalItem)

        netSpeedItem = createInfoItem(title: "🌐 NET   Calculating...")
        menu.addItem(netSpeedItem)

        menu.addItem(NSMenuItem.separator())

        // --- SUBMENU 1: Top CPU Consumers ---
        cpuHeaderItem = NSMenuItem(title: "🔥 Top CPU Processes (5 Active)", action: nil, keyEquivalent: "")
        cpuHeaderItem.attributedTitle = NSAttributedString(
            string: "🔥 Top CPU Processes (5 Active)",
            attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .bold),
                .foregroundColor: NSColor(calibratedRed: 0.98, green: 0.55, blue: 0.22, alpha: 1.0)
            ]
        )
        cpuSubMenu = NSMenu()
        cpuHeaderItem.submenu = cpuSubMenu
        menu.addItem(cpuHeaderItem)

        // --- SUBMENU 2: Top Memory Consumers ---
        ramHeaderItem = NSMenuItem(title: "🧠 Top Memory Processes (5 Active)", action: nil, keyEquivalent: "")
        ramHeaderItem.attributedTitle = NSAttributedString(
            string: "🧠 Top Memory Processes (5 Active)",
            attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .bold),
                .foregroundColor: NSColor(calibratedRed: 0.65, green: 0.45, blue: 0.98, alpha: 1.0)
            ]
        )
        ramSubMenu = NSMenu()
        ramHeaderItem.submenu = ramSubMenu
        menu.addItem(ramHeaderItem)

        // --- SUBMENU 3: Dev Tools & Actions ---
        let toolsHeader = NSMenuItem(title: "🛠️ Dev Tools & Actions", action: nil, keyEquivalent: "")
        toolsHeader.attributedTitle = NSAttributedString(
            string: "🛠️ Dev Tools & Actions",
            attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .bold), .foregroundColor: NSColor.systemGreen]
        )

        let toolsSubMenu = NSMenu()
        let purgeItem = NSMenuItem(title: "🧹 Purge Inactive RAM Cache", action: #selector(purgeMemory), keyEquivalent: "")
        purgeItem.target = self
        toolsSubMenu.addItem(purgeItem)

        let activityMonitorItem = NSMenuItem(title: "📈 Open Activity Monitor", action: #selector(openActivityMonitor), keyEquivalent: "")
        activityMonitorItem.target = self
        toolsSubMenu.addItem(activityMonitorItem)
        toolsHeader.submenu = toolsSubMenu
        menu.addItem(toolsHeader)

        // --- SUBMENU 4: Visual Style Selector ---
        let styleMenuItem = NSMenuItem(title: "🎨 Menu Bar Layout", action: nil, keyEquivalent: "")
        styleMenuItem.attributedTitle = NSAttributedString(
            string: "🎨 Menu Bar Layout",
            attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .medium)]
        )

        let styleSubMenu = NSMenu()
        let optMinimal = NSMenuItem(title: "⚡ 24%  🧠 16.2G (Minimal Space Saver)", action: #selector(setStyleMinimal), keyEquivalent: "")
        optMinimal.target = self
        optMinimal.state = currentStyle == .minimalCpuRam ? .on : .off
        styleSubMenu.addItem(optMinimal)

        let optPro = NSMenuItem(title: "⚡ 24%  🧠 16.2G  ▲ 3.8M  ▼ 1.2M (CPU + RAM + Speed)", action: #selector(setStyleProSpeed), keyEquivalent: "")
        optPro.target = self
        optPro.state = currentStyle == .proSpeed ? .on : .off
        styleSubMenu.addItem(optPro)

        let optCyber = NSMenuItem(title: "⚡ 24% [■■□□]  🧠 16.2G [■■■□]  ▲ 3.8M (Cyber Bars)", action: #selector(setStyleCyberMatrix), keyEquivalent: "")
        optCyber.target = self
        optCyber.state = currentStyle == .cyberMatrix ? .on : .off
        styleSubMenu.addItem(optCyber)

        let optCompact = NSMenuItem(title: "⚡ 24%  🧠 16.2G (67%)  ▲ 3.8M (Compact Speed)", action: #selector(setStyleCompactSpeed), keyEquivalent: "")
        optCompact.target = self
        optCompact.state = currentStyle == .compactSpeed ? .on : .off
        styleSubMenu.addItem(optCompact)

        styleMenuItem.submenu = styleSubMenu
        menu.addItem(styleMenuItem)

        menu.addItem(NSMenuItem.separator())

        // Bottom Footer: System Status (Power + Uptime combined)
        systemStatusItem = createInfoItem(title: "🔋 Power & Uptime Calculating...", color: NSColor.secondaryLabelColor)
        menu.addItem(systemStatusItem)

        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "❌ Quit Monitor Session", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

        statusItem.menu = menu
        rebuildProcessSubmenus()
    }

    @objc func setStyleMinimal() {
        currentStyle = .minimalCpuRam
        UserDefaults.standard.set("minimalCpuRam", forKey: "TechieStyle")
        buildMenu()
        updateStats()
    }

    @objc func setStyleProSpeed() {
        currentStyle = .proSpeed
        UserDefaults.standard.set("proSpeed", forKey: "TechieStyle")
        buildMenu()
        updateStats()
    }

    @objc func setStyleCyberMatrix() {
        currentStyle = .cyberMatrix
        UserDefaults.standard.set("cyberMatrix", forKey: "TechieStyle")
        buildMenu()
        updateStats()
    }

    @objc func setStyleCompactSpeed() {
        currentStyle = .compactSpeed
        UserDefaults.standard.set("compactSpeed", forKey: "TechieStyle")
        buildMenu()
        updateStats()
    }

    @objc func purgeMemory() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/sbin/purge")
            try? task.run()
            task.waitUntilExit()

            DispatchQueue.main.async {
                self?.updateStats()
            }
        }
    }

    @objc func openActivityMonitor() {
        NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/Utilities/Activity Monitor.app"))
    }

    @objc func killProcessAction(_ sender: NSMenuItem) {
        let pid = Int32(sender.tag)
        if pid > 1 {
            kill(pid, SIGKILL)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                self?.fetchTopProcesses()
                self?.updateStats()
            }
        }
    }

    func menuWillOpen(_ menu: NSMenu) {
        fetchTopProcesses()
        updateStats()
        rebuildProcessSubmenus()
    }

    func updateStats() {
        let cpuUsage = getCpuUsage()
        let (ramUsedGB, ramTotalGB, ramPercent) = getRamUsage()
        let gpuUsage = getGpuUsage()
        let (batPercent, isCharging, isAC) = getBatteryState()

        // Calculate Network Speed with rolling moving average
        let now = Date().timeIntervalSince1970
        let (ibytes, obytes) = getNetworkBytes()
        let dt = max(0.5, now - prevNetTime)

        if ibytes >= prevNetBytesIn && obytes >= prevNetBytesOut {
            let curDown = Double(ibytes - prevNetBytesIn) / dt
            let curUp = Double(obytes - prevNetBytesOut) / dt

            rollingDownloadSamples.append(curDown)
            if rollingDownloadSamples.count > 3 { rollingDownloadSamples.removeFirst() }

            rollingUploadSamples.append(curUp)
            if rollingUploadSamples.count > 3 { rollingUploadSamples.removeFirst() }
        }
        prevNetBytesIn = ibytes
        prevNetBytesOut = obytes
        prevNetTime = now

        let avgDown = rollingDownloadSamples.isEmpty ? 0 : rollingDownloadSamples.reduce(0, +) / Double(rollingDownloadSamples.count)
        let avgUp = rollingUploadSamples.isEmpty ? 0 : rollingUploadSamples.reduce(0, +) / Double(rollingUploadSamples.count)

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            let upStr = self.formatSpeed(avgUp)
            let downStr = self.formatSpeed(avgDown)
            let cpuBar = self.makeMiniBar(percent: cpuUsage, totalBars: 4)
            let ramBar = self.makeMiniBar(percent: ramPercent, totalBars: 4)

            // Format Menu Bar Title
            var titleStr = ""
            switch self.currentStyle {
            case .minimalCpuRam:
                titleStr = String(format: "⚡ %d%%  🧠 %.1fG", Int(cpuUsage), ramUsedGB)
            case .proSpeed:
                titleStr = String(format: "⚡ %d%%  🧠 %.1fG  ▲ %@  ▼ %@", Int(cpuUsage), ramUsedGB, upStr, downStr)
            case .cyberMatrix:
                titleStr = String(format: "⚡ %d%% %@  🧠 %.1fG %@  ▲ %@", Int(cpuUsage), cpuBar, ramUsedGB, ramBar, upStr)
            case .compactSpeed:
                titleStr = String(format: "⚡ %d%%  🧠 %.1fG (%d%%)  ▲ %@", Int(cpuUsage), ramUsedGB, Int(ramPercent), upStr)
            }

            // Cyberpunk Laser Alerts
            var textColor = NSColor.white
            if cpuUsage > 85.0 || ramPercent > 90.0 {
                textColor = NSColor(calibratedRed: 0.98, green: 0.25, blue: 0.35, alpha: 1.0) // 🔴 Laser Red
            } else if cpuUsage > 65.0 || ramPercent > 80.0 {
                textColor = NSColor(calibratedRed: 0.98, green: 0.70, blue: 0.20, alpha: 1.0) // 🟡 Cyber Amber
            }

            if let button = self.statusItem.button {
                button.attributedTitle = NSAttributedString(
                    string: titleStr,
                    attributes: [
                        .font: NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .bold),
                        .foregroundColor: textColor,
                    ]
                )
            }

            let cpuProgress = self.makeProgressBarText(percent: cpuUsage, totalBlocks: 10)
            let ramProgress = self.makeProgressBarText(percent: ramPercent, totalBlocks: 10)
            let gpuProgress = self.makeProgressBarText(percent: gpuUsage, totalBlocks: 10)

            self.cpuTotalItem?.attributedTitle = NSAttributedString(
                string: String(format: "⚡ CPU   %@ %5.1f%% (E:%2.0f%% │ P:%2.0f%%)", cpuProgress, cpuUsage, self.eCoreUsage, self.pCoreUsage),
                attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .medium), .foregroundColor: NSColor.white]
            )

            self.ramTotalItem?.attributedTitle = NSAttributedString(
                string: String(format: "🧠 RAM   %@  %.1fG / %.1fG (%d%%)", ramProgress, ramUsedGB, ramTotalGB, Int(ramPercent)),
                attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .medium), .foregroundColor: NSColor.white]
            )

            self.gpuTotalItem?.attributedTitle = NSAttributedString(
                string: String(format: "🎮 GPU   %@ %5.1f%% (Metal 4 Engine)", gpuProgress, gpuUsage),
                attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .medium), .foregroundColor: NSColor.white]
            )

            self.netSpeedItem?.attributedTitle = NSAttributedString(
                string: String(format: "🌐 NET   ▲ %@ Upstream  │  ▼ %@ Downstream", upStr, downStr),
                attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .medium), .foregroundColor: NSColor.white]
            )

            let powerStateStr = isCharging ? "⚡" : (isAC ? "🔌" : "🔋")
            let uptime = ProcessInfo.processInfo.systemUptime
            let hours = Int(uptime) / 3600
            let mins = (Int(uptime) % 3600) / 60

            self.systemStatusItem?.attributedTitle = NSAttributedString(
                string: String(format: "🔋 Bat: %d%% (%@)  │  ⏱️ Uptime: %02dh %02dm", batPercent, powerStateStr, hours, mins),
                attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular), .foregroundColor: NSColor.secondaryLabelColor]
            )

            self.rebuildProcessSubmenus()
        }
    }

    func formatSpeed(_ bytesPerSec: Double) -> String {
        if bytesPerSec >= 1_048_576.0 {
            return String(format: "%.1fM", bytesPerSec / 1_048_576.0)
        } else if bytesPerSec >= 1024.0 {
            return String(format: "%.0fK", bytesPerSec / 1024.0)
        } else {
            return "< 1K"
        }
    }

    func rebuildProcessSubmenus() {
        guard let cpuSub = cpuSubMenu, let ramSub = ramSubMenu else { return }

        cpuSub.removeAllItems()
        let cpuTitle = NSMenuItem(title: "🔥 TOP CPU CONSUMERS (Click to Kill):", action: #selector(dummyAction), keyEquivalent: "")
        cpuTitle.target = self
        cpuTitle.attributedTitle = NSAttributedString(
            string: "🔥 TOP CPU CONSUMERS (Click to Kill):",
            attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .bold), .foregroundColor: NSColor.systemOrange]
        )
        cpuSub.addItem(cpuTitle)
        cpuSub.addItem(NSMenuItem.separator())

        for p in topCpuProcesses.prefix(5) {
            let badge = p.isProtected ? "🛡️ SYS" : "🔴 KILL"
            let text = String(format: "▶ %-16@ %5.1f%% CPU  [%@]", p.name, p.cpu, badge)

            let item = NSMenuItem(
                title: text,
                action: p.isProtected ? #selector(dummyAction) : #selector(killProcessAction(_:)),
                keyEquivalent: ""
            )
            item.tag = Int(p.pid)
            item.target = self
            item.attributedTitle = NSAttributedString(
                string: text,
                attributes: [
                    .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .medium),
                    .foregroundColor: p.isProtected ? NSColor.secondaryLabelColor : NSColor.white
                ]
            )
            cpuSub.addItem(item)
        }

        ramSub.removeAllItems()
        let ramTitle = NSMenuItem(title: "🧠 TOP MEMORY CONSUMERS (Click to Kill):", action: #selector(dummyAction), keyEquivalent: "")
        ramTitle.target = self
        ramTitle.attributedTitle = NSAttributedString(
            string: "🧠 TOP MEMORY CONSUMERS (Click to Kill):",
            attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .bold), .foregroundColor: NSColor.systemPurple]
        )
        ramSub.addItem(ramTitle)
        ramSub.addItem(NSMenuItem.separator())

        for p in topMemProcesses.prefix(5) {
            let memStr = p.memMB >= 1024
                ? String(format: "%.2f GB", p.memMB / 1024.0)
                : String(format: "%4.0f MB", p.memMB)

            let badge = p.isProtected ? "🛡️ SYS" : "🔴 KILL"
            let text = String(format: "▶ %-16@ %@  [%@]", p.name, memStr, badge)

            let item = NSMenuItem(
                title: text,
                action: p.isProtected ? #selector(dummyAction) : #selector(killProcessAction(_:)),
                keyEquivalent: ""
            )
            item.tag = Int(p.pid)
            item.target = self
            item.attributedTitle = NSAttributedString(
                string: text,
                attributes: [
                    .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .medium),
                    .foregroundColor: p.isProtected ? NSColor.secondaryLabelColor : NSColor.white
                ]
            )
            ramSub.addItem(item)
        }
    }

    func fetchTopProcesses() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self else { return }

            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/ps")
            task.arguments = ["-axo", "pid,%cpu,rss,comm", "-r"]

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
                        let parts = line.trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
                        if parts.count == 4 {
                            let pid = Int32(parts[0]) ?? 0
                            let cpu = Double(parts[1]) ?? 0.0
                            let rssKB = Double(parts[2]) ?? 0.0
                            let fullPath = String(parts[3])
                            let rawName = (fullPath as NSString).lastPathComponent

                            if !rawName.isEmpty && rawName != "ps" && rawName != "grep" && pid > 0 {
                                let displayName = self.cleanProcessName(rawName)
                                let isProtected = self.protectedSystemProcesses.contains(rawName) || self.protectedSystemProcesses.contains(displayName)
                                let stat = ProcessStat(pid: pid, name: displayName, rawName: rawName, cpu: cpu, memMB: rssKB / 1024.0, isProtected: isProtected)
                                cpuList.append(stat)
                                memList.append(stat)
                            }
                        }
                    }

                    cpuList.sort { $0.cpu > $1.cpu }
                    memList.sort { $0.memMB > $1.memMB }

                    DispatchQueue.main.async {
                        self.topCpuProcesses = Array(cpuList.prefix(5))
                        self.topMemProcesses = Array(memList.prefix(5))
                    }
                }
            } catch {
                // Ignore background errors
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
        var eInUse: Int32 = 0
        var eTotal: Int32 = 0
        var pInUse: Int32 = 0
        var pTotal: Int32 = 0

        if let prevCpuInfo = prevCpuInfo {
            var inUse: Int32 = 0
            var total: Int32 = 0
            let numCPUs = Int32(numCPUsU)

            for i in 0..<numCPUs {
                let offset = Int(i) * Int(CPU_STATE_MAX)
                let user = cpuInfo[offset + Int(CPU_STATE_USER)] - prevCpuInfo[offset + Int(CPU_STATE_USER)]
                let sys = cpuInfo[offset + Int(CPU_STATE_SYSTEM)] - prevCpuInfo[offset + Int(CPU_STATE_SYSTEM)]
                let nice = cpuInfo[offset + Int(CPU_STATE_NICE)] - prevCpuInfo[offset + Int(CPU_STATE_NICE)]
                let idle = cpuInfo[offset + Int(CPU_STATE_IDLE)] - prevCpuInfo[offset + Int(CPU_STATE_IDLE)]

                let coreInUse = user + sys + nice
                let coreTotal = user + sys + nice + idle

                inUse += coreInUse
                total += coreTotal

                if i < 4 {
                    eInUse += coreInUse
                    eTotal += coreTotal
                } else {
                    pInUse += coreInUse
                    pTotal += coreTotal
                }
            }

            if total > 0 {
                totalUsage = (Double(inUse) / Double(total)) * 100.0
            }
            if eTotal > 0 {
                eCoreUsage = (Double(eInUse) / Double(eTotal)) * 100.0
            }
            if pTotal > 0 {
                pCoreUsage = (Double(pInUse) / Double(pTotal)) * 100.0
            }

            let prevSize = vm_size_t(numPrevCpuInfo) * vm_size_t(MemoryLayout<integer_t>.stride)
            vm_deallocate(mach_task_self_, vm_address_t(UInt(bitPattern: prevCpuInfo)), prevSize)
        }

        prevCpuInfo = cpuInfo
        numPrevCpuInfo = numCpuInfo
        totalCpuUsage = min(100.0, max(0.0, totalUsage))
        return totalCpuUsage
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

    func getGpuUsage() -> Double {
        var iterator: io_iterator_t = 0
        let matchDict = IOServiceMatching("IOAccelerator")
        guard IOServiceGetMatchingServices(kIOMainPortDefault, matchDict, &iterator) == kIOReturnSuccess else {
            return 0.0
        }
        defer { IOObjectRelease(iterator) }

        var service = IOIteratorNext(iterator)
        while service != 0 {
            var props: Unmanaged<CFMutableDictionary>?
            if IORegistryEntryCreateCFProperties(service, &props, kCFAllocatorDefault, 0) == kIOReturnSuccess,
               let dict = props?.takeRetainedValue() as? [String: Any],
               let stats = dict["PerformanceStatistics"] as? [String: Any] {
                if let util = stats["Device Utilization %"] as? NSNumber {
                    IOObjectRelease(service)
                    return util.doubleValue
                }
            }
            IOObjectRelease(service)
            service = IOIteratorNext(iterator)
        }
        return 0.0
    }

    func getBatteryState() -> (Int, Bool, Bool) {
        let snapshot = IOPSCopyPowerSourcesInfo().takeRetainedValue()
        let sources = IOPSCopyPowerSourcesList(snapshot).takeRetainedValue() as [AnyObject]

        for ps in sources {
            if let desc = IOPSGetPowerSourceDescription(snapshot, ps).takeUnretainedValue() as? [String: Any] {
                let current = desc[kIOPSCurrentCapacityKey] as? Int ?? 0
                let max = desc[kIOPSMaxCapacityKey] as? Int ?? 100
                let isCharging = desc[kIOPSIsChargingKey] as? Bool ?? false
                let powerSource = desc[kIOPSPowerSourceStateKey] as? String ?? ""
                let isAC = powerSource == kIOPSACPowerValue
                let percent = max > 0 ? (current * 100) / max : 0
                return (percent, isCharging, isAC)
            }
        }
        return (100, false, true)
    }

    func getNetworkBytes() -> (UInt64, UInt64) {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return (0, 0) }
        defer { freeifaddrs(ifaddr) }

        var ibytes: UInt64 = 0
        var obytes: UInt64 = 0

        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            if (flags & (IFF_UP | IFF_RUNNING)) != 0 && (flags & IFF_LOOPBACK) == 0 {
                if ptr.pointee.ifa_addr.pointee.sa_family == UInt8(AF_LINK) {
                    if let data = ptr.pointee.ifa_data {
                        let networkData = data.assumingMemoryBound(to: if_data.self)
                        ibytes += UInt64(networkData.pointee.ifi_ibytes)
                        obytes += UInt64(networkData.pointee.ifi_obytes)
                    }
                }
            }
        }
        return (ibytes, obytes)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
