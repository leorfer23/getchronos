// Mission Control — Tauri desktop shell.
// A thin native window over the local Chronos daemon (http://localhost:7777), plus a
// global hotkey (Cmd+Shift+M) to summon/hide the window from anywhere.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

// WKWebView blocks getUserMedia unless its UIDelegate answers the media-capture
// permission callback — wry doesn't implement it, so the prompt never fires and the
// mic silently denies. Add the method at runtime and auto-grant (localhost only).
#[cfg(target_os = "macos")]
fn grant_webview_mic(window: &tauri::WebviewWindow) {
    use block2::Block;
    use objc2::ffi::class_addMethod;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Sel};
    use objc2::{msg_send, sel};

    // WKPermissionDecision: prompt=0, grant=1, deny=2
    extern "C-unwind" fn grant(
        _this: *mut AnyObject,
        _cmd: Sel,
        _webview: *mut AnyObject,
        _origin: *mut AnyObject,
        _frame: *mut AnyObject,
        _typ: isize,
        handler: *mut Block<dyn Fn(isize)>,
    ) {
        unsafe { (*handler).call((1,)) };
    }

    let _ = window.with_webview(|wv| unsafe {
        let webview: *mut AnyObject = wv.inner() as _;
        if webview.is_null() {
            return;
        }
        let delegate: Option<Retained<AnyObject>> = msg_send![webview, UIDelegate];
        let Some(delegate) = delegate else { return };
        let cls: *const AnyClass = msg_send![&*delegate, class];
        let sel = sel!(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:);
        let imp: objc2::runtime::Imp = std::mem::transmute::<extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut AnyObject, isize, *mut Block<dyn Fn(isize)>), objc2::runtime::Imp>(grant);
        // v@:@@@q@?  -> void (self, _cmd, webview, origin, frame, NSInteger, block)
        class_addMethod(cls as *mut _, sel, imp, c"v@:@@@q@?".as_ptr());
    });
}

fn toggle(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut("CmdOrCtrl+Shift+M")
                .expect("invalid shortcut")
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if let Some(w) = app.get_webview_window("main") {
                grant_webview_mic(&w);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Mission Control");
}
