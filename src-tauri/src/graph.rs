// graph.rs - Knowledge graph construction
use crate::app::FileEntry;
use chrono::Utc;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub title: String,
    pub path: String,
    pub workspace_id: String,
    pub tags: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Graph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub version: u64,
}

pub fn build_graph(files: &[FileEntry]) -> Graph {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut edge_set = HashSet::new();
    let mut id_map = HashMap::new();

    // Create nodes
    for file in files {
        let id = sanitize_id(&file.path);
        id_map.insert(file.path.clone(), id.clone());
        nodes.push(GraphNode {
            id,
            title: file.title.clone(),
            path: file.path.clone(),
            workspace_id: file.workspace_id.clone(),
            tags: file.tags.clone(),
        });
    }

    // Build edges from wikilinks and references in content
    for file in files {
        let source_id = match id_map.get(&file.path) {
            Some(id) => id.clone(),
            None => continue,
        };

        // Find [[wiki]] links
        let content = file.content.as_deref().unwrap_or("");
        let mut search_start = 0;
        while let Some(start) = content[search_start..].find("[[") {
            let start = search_start + start + 2;
            if let Some(end) = content[start..].find("]]") {
                let link_text = &content[start..start + end];
                let target_path = resolve_wikilink(link_text, file, files);
                if let Some(tp) = &target_path {
                    if let Some(target_id) = id_map.get(tp) {
                        let key = format!("{}->{}", source_id, target_id);
                        if edge_set.insert(key) {
                            edges.push(GraphEdge {
                                from: source_id.clone(),
                                to: target_id.clone(),
                                label: "wikilink".to_string(),
                            });
                        }
                    }
                }
                search_start = start + end + 2;
            } else {
                break;
            }
        }
    }

    Graph {
        nodes,
        edges,
        version: Utc::now().timestamp_millis() as u64,
    }
}

fn sanitize_id(path: &str) -> String {
    path.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' => c,
            _ => '_',
        })
        .collect()
}

fn resolve_wikilink(link_text: &str, current_file: &FileEntry, files: &[FileEntry]) -> Option<String> {
    let target_name = link_text.split('|').next().unwrap_or(link_text).trim();

    // Try exact match in current workspace
    let workspace_files: Vec<&FileEntry> = files
        .iter()
        .filter(|f| f.workspace_id == current_file.workspace_id)
        .collect();

    // Try exact title match
    for f in &workspace_files {
        if f.title == target_name || f.title == target_name.trim_end_matches(".md") {
            return Some(f.path.clone());
        }
    }

    // Try filename match
    for f in &workspace_files {
        let name = std::path::Path::new(&f.path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if name == target_name || name == target_name.trim_end_matches(".md") {
            return Some(f.path.clone());
        }
    }

    // Try path suffix match
    for f in &workspace_files {
        if f.path.ends_with(&format!("/{}", target_name))
            || f.path.ends_with(&format!("/{}.md", target_name))
        {
            return Some(f.path.clone());
        }
    }

    None
}
