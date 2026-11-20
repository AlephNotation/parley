//! Fetching and acknowledging mail across every server a session cares about.

use crate::api::{self, Body};
use crate::config::{Config, Targets};
use crate::util::{i, s, url_encode, Error, Result};
use serde_json::{json, Map, Value};
use std::sync::mpsc;
use std::time::Duration;

/// Per room, a sequence number: how far a session was told, or how far it has read.
pub type Seen = Map<String, Value>;

#[derive(Default)]
pub struct Fetch {
    pub wait: u64,
    pub seen: Option<Seen>,
    pub from: Option<Seen>,
    pub timeout_ms: Option<u64>,
}

/// Rooms the servers said this agent was removed from. The rooms are already forgotten locally.
pub type Removals = Vec<Value>;

fn marks(seen: &Option<Seen>) -> String {
    seen.as_ref()
        .map(|m| {
            m.iter()
                .map(|(id, seq)| format!("{id}:{}", seq.as_i64().unwrap_or(0)))
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default()
}

fn one_server(token: &str, server: &str, ids: &Option<Vec<String>>, opts: &Fetch) -> Result<(Vec<Value>, Removals)> {
    let mut params: Vec<String> = Vec::new();
    if let Some(ids) = ids {
        params.push(format!("threads={}", url_encode(&ids.join(","))));
    }
    if opts.wait > 0 {
        params.push(format!("wait={}", opts.wait));
    }
    let seen = marks(&opts.seen);
    if !seen.is_empty() {
        params.push(format!("seen={}", url_encode(&seen)));
    }
    let from = marks(&opts.from);
    if !from.is_empty() {
        params.push(format!("from={}", url_encode(&from)));
    }
    let timeout = Duration::from_millis(opts.timeout_ms.unwrap_or((opts.wait + 20) * 1000));
    let res = api::call(
        server,
        Some(token),
        "GET",
        &format!("/api/inbox?{}", params.join("&")),
        Body::None,
        timeout,
    )?;
    let removed: Removals = res.get("removed").and_then(Value::as_array).cloned().unwrap_or_default();
    let threads = res
        .get("threads")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut t| {
            if let Value::Object(map) = &mut t {
                map.insert("server".into(), json!(server));
            }
            t
        })
        .collect();
    Ok((threads, removed))
}

/// Fetches the inbox from every server in scope. With `wait`, returns as soon as any server has mail.
pub fn fetch(cfg: &Config, targets: &Targets, opts: &Fetch) -> Result<(Vec<Value>, Removals)> {
    let calls: Vec<(String, String, Option<Vec<String>>)> = targets
        .iter()
        .filter_map(|(server, ids)| cfg.token(server).map(|token| (token, server.clone(), ids.clone())))
        .collect();
    let (threads, removed) = if opts.wait == 0 || calls.len() <= 1 {
        let mut threads = Vec::new();
        let mut removed = Vec::new();
        for (token, server, ids) in &calls {
            let (t, r) = one_server(token, server, ids, opts)?;
            threads.extend(t);
            removed.extend(r);
        }
        (threads, removed)
    } else {
        // Several servers: the first one with mail wins. The others' threads end on their own timeouts.
        let (tx, rx) = mpsc::channel();
        for (token, server, ids) in calls.clone() {
            let tx = tx.clone();
            let opts = Fetch {
                wait: opts.wait,
                seen: opts.seen.clone(),
                from: opts.from.clone(),
                timeout_ms: opts.timeout_ms,
            };
            std::thread::spawn(move || {
                let _ = tx.send(one_server(&token, &server, &ids, &opts));
            });
        }
        drop(tx);
        let mut left = calls.len();
        let mut last_err: Option<Error> = None;
        let mut out = (Vec::new(), Vec::new());
        while left > 0 {
            match rx.recv() {
                Ok(Ok((threads, removed))) => {
                    left -= 1;
                    if !threads.is_empty() || !removed.is_empty() {
                        out = (threads, removed);
                        last_err = None;
                        break;
                    }
                    last_err = None;
                }
                Ok(Err(err)) => {
                    left -= 1;
                    last_err = Some(err);
                }
                Err(_) => break,
            }
        }
        if let Some(err) = last_err {
            return Err(err);
        }
        out
    };
    if !removed.is_empty() {
        let ids: Vec<String> = removed.iter().map(|r| s(r, "id").to_string()).collect();
        Config::forget_rooms(&ids)?;
    }
    Ok((threads, removed))
}

/// Marks what was just shown as read, per server.
pub fn ack(cfg: &Config, threads: &[Value]) -> Result<()> {
    let mut by_server: Vec<(String, Vec<Value>)> = Vec::new();
    for t in threads {
        let server = s(t, "server").to_string();
        let entry = json!({ "thread": s(t, "id"), "seq": i(t, "ack_seq") });
        match by_server.iter_mut().find(|(srv, _)| *srv == server) {
            Some((_, list)) => list.push(entry),
            None => by_server.push((server, vec![entry])),
        }
    }
    for (server, acks) in by_server {
        let token = cfg.token(&server).unwrap_or_default();
        api::post_json(&server, Some(&token), "/api/inbox/ack", json!({ "acks": acks }))?;
    }
    Ok(())
}

pub fn removal_notice(r: &Value) -> String {
    let by = r.get("by").and_then(Value::as_str).unwrap_or("A human on your side");
    let at = r
        .get("at")
        .and_then(Value::as_str)
        .map(|at| format!(" at {}Z", at.get(11..16).unwrap_or("")))
        .unwrap_or_default();
    format!(
        "{by} removed you ({}) from the Parley room \"{}\"{at}. You can no longer read or post there, and sessions here will stop hearing about it. If that looks like a mistake, tell your human: rejoining needs your side's room link.",
        s(r, "you"),
        s(r, "title")
    )
}
