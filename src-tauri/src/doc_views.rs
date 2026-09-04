// doc_views.rs — 文档浏览记录持久化
// 对应 server/doc-views.js，记录用户浏览文档的时间和次数。
// 企业级标准：浏览记录是知识管理温习提醒的数据基础，
// 持久化必须保证原子写入，防止数据丢失。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tokio::sync::OnceCell;

/// 单条文档浏览记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocView {
    pub viewed_at: u64, // Unix 毫秒时间戳
    pub view_count: u32,
}

/// 文档浏览记录存储
pub struct DocViewStore {
    file_path: PathBuf,
    views: Mutex<HashMap<String, DocView>>,
    loaded: Mutex<bool>,
    save_timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
    // OnceCell 用于延迟加载
    init: OnceCell<()>,
}

impl DocViewStore {
    pub fn new(data_root: &Path) -> Self {
        let file_path = data_root.join("doc-views.json");
        DocViewStore {
            file_path,
            views: Mutex::new(HashMap::new()),
            loaded: Mutex::new(false),
            save_timer: Mutex::new(None),
            init: OnceCell::new(),
        }
    }

    /// 异步加载（首次调用时触发）
    pub async fn ensure_loaded(&self) -> Result<(), anyhow::Error> {
        self.init
            .get_or_init(|| async {
                let _ = self.load_sync();
            })
            .await;
        Ok(())
    }

    fn load_sync(&self) -> Result<(), anyhow::Error> {
        let mut loaded = self.loaded.lock().unwrap();
        if *loaded {
            return Ok(());
        }
        match std::fs::read_to_string(&self.file_path) {
            Ok(content) => {
                let parsed: HashMap<String, DocView> = serde_json::from_str(&content)
                    .unwrap_or_default();
                let mut views = self.views.lock().unwrap();
                *views = parsed;
            }
            Err(_) => {
                // 首次使用或文件损坏时静默初始化为空
            }
        }
        *loaded = true;
        Ok(())
    }

    /// 记录文档浏览
    pub async fn record(&self, doc_path: &str) -> Result<(), anyhow::Error> {
        if doc_path.is_empty() {
            return Ok(());
        }
        self.ensure_loaded().await?;
        let now = chrono::Utc::now().timestamp_millis() as u64;
        {
            let mut views = self.views.lock().unwrap();
            let entry = views.entry(doc_path.to_string()).or_insert(DocView {
                viewed_at: 0,
                view_count: 0,
            });
            entry.viewed_at = now;
            entry.view_count += 1;
        }
        self.schedule_save();
        Ok(())
    }

    /// 延迟持久化（800ms 防抖）
    fn schedule_save(&self) {
        let mut timer = self.save_timer.lock().unwrap();
        if timer.is_some() {
            return;
        }
        let file_path = self.file_path.clone();
        let views = {
            let views = self.views.lock().unwrap();
            views.clone()
        };
        let handle = tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
            if let Err(e) = persist(&file_path, &views) {
                log::warn!("doc-views 持久化失败: {e}");
            }
        });
        *timer = Some(handle);
    }

    /// 获取快照
    pub fn snapshot(&self) -> HashMap<String, DocView> {
        self.views.lock().unwrap().clone()
    }
}

/// 原子写入文件：先写临时文件，再 rename
fn persist(file_path: &Path, views: &HashMap<String, DocView>) -> Result<(), anyhow::Error> {
    if let Some(dir) = file_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let content = serde_json::to_string_pretty(views)?;
    let tmp = file_path.with_extension("json.tmp");
    std::fs::write(&tmp, &content)?;
    // Windows 上 rename 可能失败，回退到直接写入
    match std::fs::rename(&tmp, file_path) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::write(file_path, &content)?;
            let _ = std::fs::remove_file(&tmp);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_doc_view_serde() {
        let view = DocView {
            viewed_at: 1700000000000,
            view_count: 5,
        };
        let json = serde_json::to_string(&view).unwrap();
        let back: DocView = serde_json::from_str(&json).unwrap();
        assert_eq!(back.view_count, 5);
    }
}
