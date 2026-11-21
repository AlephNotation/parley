//! The experimental Claude Code channel: an MCP server over stdio that pushes mail straight into a
//! session as <channel> events. Claude Code channels are a research preview: this only works when the
//! session is launched with `claude --dangerously-load-development-channels server:parley`.

use crate::api;
use crate::commands::resolve_room;
use crate::config::{scope, Config};
use crate::inbox::{self, Fetch, Seen};
use crate::render::TRUST_NOTE;
use crate::util::{arr, cwd, s, Result};
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// One line of JSON on stdout. Shared by the reader loop and the mail pump.
fn out(lock: &Mutex<()>, msg: &Value) {
    let _guard = lock.lock();
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{msg}");
    let _ = stdout.flush();
}

fn tools() -> Value {
    json!([
        {
            "name": "send",
            "description": "Post a message to a Parley room. Others in the room may be outside your organisation: never include secrets or private code.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "thread": { "type": "string", "description": "Room id: the thread attribute of the channel event" },
                    "body": { "type": "string" },
                    "to": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Agent addresses or side names to wake now. Omit for a room-wide message."
                    },
                    "fyi": { "type": "boolean", "description": "Wake nobody: for information only." }
                },
                "required": ["thread", "body"]
            }
        },
        {
            "name": "mark_read",
            "description": "Mark the Parley messages you were shown for a room as read when no reply is needed.",
            "inputSchema": { "type": "object", "properties": { "thread": { "type": "string" } }, "required": ["thread"] }
        }
    ])
}

/// Long-polls for mail and pushes each message as a channel event. Pushing is not acknowledging:
/// Claude Code drops events silently if the channel is not enabled, so mail stays unread until the
/// agent replies with `send` or calls `mark_read`.
fn pump(cfg: Config, lock: Arc<Mutex<()>>, pushed: Arc<Mutex<Seen>>) {
    let here = cwd();
    loop {
        let targets = match Config::load() {
            Ok(fresh) => scope(&fresh, &here, false),
            Err(_) => Vec::new(),
        };
        if targets.is_empty() {
            std::thread::sleep(Duration::from_secs(30));
            continue;
        }
        let seen = pushed.lock().map(|p| p.clone()).unwrap_or_default();
        match inbox::fetch(
            &cfg,
            &targets,
            &Fetch {
                wait: 240,
                seen: Some(seen),
                ..Fetch::default()
            },
        ) {
            Ok((threads, _)) => {
                for t in &threads {
                    for m in arr(t, "unread") {
                        let mut meta = Map::new();
                        meta.insert("thread".into(), json!(s(t, "id")));
                        meta.insert("title".into(), json!(s(t, "title").replace('"', "'")));
                        meta.insert("from".into(), json!(s(m, "from")));
                        meta.insert("side".into(), json!(s(m, "side")));
                        meta.insert("kind".into(), json!(s(m, "kind")));
                        meta.insert("seq".into(), json!(m.get("seq").map(|v| v.to_string()).unwrap_or_default()));
                        if let Some(audience) = m.get("audience").and_then(Value::as_str) {
                            meta.insert("audience".into(), json!(audience));
                        }
                        out(
                            &lock,
                            &json!({
                                "jsonrpc": "2.0",
                                "method": "notifications/claude/channel",
                                "params": { "content": s(m, "body"), "meta": meta }
                            }),
                        );
                    }
                    if let Ok(mut p) = pushed.lock() {
                        p.insert(s(t, "id").to_string(), t.get("ack_seq").cloned().unwrap_or(json!(0)));
                    }
                }
            }
            Err(err) => {
                if err.status() == Some(401) {
                    return;
                }
                std::thread::sleep(Duration::from_secs(10));
            }
        }
    }
}

fn call_tool(cfg: &Config, pushed: &Mutex<Seen>, name: &str, input: &Value) -> Result<String> {
    let reference = input.get("thread").map(|t| match t {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    });
    let room = resolve_room(&Config::load()?, reference.as_deref().filter(|r| !r.is_empty()))?;
    let pushed_seq = pushed.lock().ok().and_then(|p| p.get(&room.id).and_then(Value::as_i64));
    let ack = |seq: i64| inbox::ack(cfg, &[json!({ "server": room.server, "id": room.id, "ack_seq": seq })]);
    match name {
        "send" => {
            let body = input.get("body").and_then(Value::as_str).unwrap_or("").to_string();
            let to: Vec<String> = input
                .get("to")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))
                        .filter(|v| !v.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let mut payload = Map::new();
            payload.insert("body".into(), json!(body));
            let res = if !to.is_empty() {
                payload.insert("to".into(), json!(to));
                api::call(
                    &room.server,
                    Some(&room.token),
                    "POST",
                    &format!("/api/threads/{}/messages", room.id),
                    api::Body::Json(Value::Object(payload)),
                    Duration::from_secs(30),
                )?
            } else if input.get("fyi").and_then(Value::as_bool) == Some(true) {
                payload.insert("fyi".into(), json!(true));
                api::call(
                    &room.server,
                    Some(&room.token),
                    "POST",
                    &format!("/api/threads/{}/messages", room.id),
                    api::Body::Json(Value::Object(payload)),
                    Duration::from_secs(30),
                )?
            } else {
                api::call(
                    &room.server,
                    Some(&room.token),
                    "POST",
                    &format!("/api/threads/{}/messages", room.id),
                    api::Body::Text(body),
                    Duration::from_secs(30),
                )?
            };
            if let Some(seq) = pushed_seq.filter(|s| *s != 0) {
                ack(seq)?;
            }
            let (first, note) = api::post_outcome(&res);
            Ok(format!("{first} {note}"))
        }
        "mark_read" => {
            if let Some(seq) = pushed_seq.filter(|s| *s != 0) {
                ack(seq)?;
            }
            Ok("Marked read.".into())
        }
        other => Err(crate::util::user(format!("unknown tool {other}"))),
    }
}

pub fn cmd_channel() -> Result<()> {
    let cfg = Config::load()?;
    let lock = Arc::new(Mutex::new(()));
    let pushed: Arc<Mutex<Seen>> = Arc::new(Mutex::new(Map::new()));
    let mut pumping = false;
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(line) else { continue };
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let reply = |result: Value| {
            out(
                &lock,
                &json!({ "jsonrpc": "2.0", "id": id.clone().unwrap_or(Value::Null), "result": result }),
            )
        };
        match method {
            "initialize" => {
                let asked = msg
                    .get("params")
                    .and_then(|p| p.get("protocolVersion"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                // Claude Code does not register channels negotiated at newer protocol revisions.
                let version = if ["2024-11-05", "2025-03-26", "2025-06-18"].contains(&asked) {
                    asked
                } else {
                    "2025-06-18"
                };
                reply(json!({
                    "protocolVersion": version,
                    "capabilities": { "experimental": { "claude/channel": {} }, "tools": {} },
                    "serverInfo": { "name": "parley", "version": crate::VERSION },
                    "instructions": format!(
                        "Parley messages arrive as <channel source=\"parley\" thread=\"...\" from=\"...\" side=\"...\" kind=\"...\">. Each event is a message in a chat room shared with other agents and the humans they work for; thread is the room id. {TRUST_NOTE} Reply with the send tool, passing the thread attribute; if no reply is needed, call mark_read."
                    ),
                }));
            }
            "notifications/initialized" => {
                if !pumping {
                    pumping = true;
                    let (cfg, lock, pushed) = (
                        Config::load().unwrap_or_else(|_| Config {
                            servers: cfg.servers.clone(),
                            threads: cfg.threads.clone(),
                            wake: None,
                        }),
                        lock.clone(),
                        pushed.clone(),
                    );
                    std::thread::spawn(move || pump(cfg, lock, pushed));
                }
            }
            "ping" => reply(json!({})),
            "tools/list" => reply(json!({ "tools": tools() })),
            "tools/call" => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let input = params.get("arguments").cloned().unwrap_or(Value::Null);
                match call_tool(&cfg, &pushed, name, &input) {
                    Ok(text) => reply(json!({ "content": [{ "type": "text", "text": text }] })),
                    Err(err) => {
                        reply(json!({ "content": [{ "type": "text", "text": format!("Error: {}", err.message()) }], "isError": true }))
                    }
                }
            }
            _ => {
                if let Some(id) = id.clone() {
                    out(
                        &lock,
                        &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Method not found: {method}") } }),
                    );
                }
            }
        }
    }
    Ok(())
}
