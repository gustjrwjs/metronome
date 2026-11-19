// 윈도우에서 실행할 때 검은 콘솔 창이 뜨지 않게
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 시작할 때 새 버전 확인 (인터넷이 없으면 조용히 넘어감)
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = check_update(handle).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("메트로놈 실행 오류");
}

async fn check_update(app: tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(());
    };
    let version = update.version.clone();
    let dlg = app.clone();
    let yes = tauri::async_runtime::spawn_blocking(move || {
        dlg.dialog()
            .message(format!("새 버전 {version}이(가) 나왔습니다.\n지금 업데이트할까요?"))
            .title("메트로놈 업데이트")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom("업데이트".into(), "나중에".into()))
            .blocking_show()
    })
    .await?;
    if !yes {
        return Ok(());
    }
    // 내려받아 설치 → 설치가 끝나면 새 버전으로 다시 실행
    update.download_and_install(|_, _| {}, || {}).await?;
    app.restart();
}
