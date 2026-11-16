import AppKit

final class WorkbenchApplication: NSObject, NSApplicationDelegate {
    private var controller: WorkbenchWindow?
    private var quitting = false

    /// Build the menu/window and probe the local server without automatically starting it.
    /// @param notification: Launch event. @pre Main thread.
    /// @post Native window visible or configuration error shown. @return None. @throws None.
    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let controller = WorkbenchWindow(config: try HostConfiguration())
            self.controller = controller
            makeMenus(controller)
            controller.start()
        } catch { NSAlert(error: error).runModal(); NSApp.terminate(nil) }
    }

    /// Preserve standard text editing shortcuts and expose only native recovery actions.
    /// @param controller: Action owner. @pre Main thread.
    /// @post Standard app/edit/window menus available. @return None. @throws None.
    private func makeMenus(_ controller: WorkbenchWindow) {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let app = NSMenu(); appItem.submenu = app
        app.addItem(withTitle: "About Research Workbench", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        let start = app.addItem(withTitle: "Launch Server", action: #selector(WorkbenchWindow.launchServer), keyEquivalent: "")
        start.target = controller
        let stop = app.addItem(withTitle: "Stop Server…", action: #selector(WorkbenchWindow.stopServer), keyEquivalent: "")
        stop.target = controller
        let reload = app.addItem(withTitle: "Reload Editor", action: #selector(WorkbenchWindow.reloadEditor), keyEquivalent: "r")
        reload.target = controller
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Research Workbench", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit Research Workbench", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit"); editItem.submenu = edit
        for (title, selector, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"),
                                       ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: NSSelectorFromString(selector), keyEquivalent: key)
        }
        let windowItem = NSMenuItem(); main.addItem(windowItem)
        let window = NSMenu(title: "Window"); windowItem.submenu = window
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        NSApp.mainMenu = main
        NSApp.windowsMenu = window
    }

    /// Subject Cmd-Q to the same unsaved-work check as window close.
    /// @param sender: Application. @pre Main thread.
    /// @post Shared servers survive; bounded in-progress helper completes/cleans itself independently.
    /// @return TerminateReply: Async permission when an editor exists. @throws None.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let controller = controller else { return .terminateNow }
        if quitting { return .terminateCancel }
        quitting = true
        controller.confirmLeaving { allowed in
            DispatchQueue.main.async {
                self.quitting = false
                sender.reply(toApplicationShouldTerminate: allowed)
            }
        }
        return .terminateLater
    }
}

let application = NSApplication.shared
let delegate = WorkbenchApplication()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
