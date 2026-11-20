//! The files on disk: `~/.parley/config.json` and the per-session state files. Same shapes as the
//! Bun client writes, so either client can read what the other left.

use crate::util::{canonical, env, home_dir, in_dir, path_str, pretty, read_text, user, user_hint, write_private, Result};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub fn parley_home() -> PathBuf {
    env("PARLEY_HOME").map(PathBuf::from).unwrap_or_else(|| home_dir().join(".parley"))
}

pub fn config_path() -> PathBuf {
    parley_home().join("config.json")
}

/// `{ servers: { origin: {token, address} }, threads: { id: {server, title, dir} }, wake?: {secret} }`
pub struct Config {
    pub servers: Map<String, Value>,
    pub threads: Map<String, Value>,
    pub wake: Option<Value>,
}

impl Config {
    pub fn load() -> Result<Config> {
        let path = config_path();
        if !path.exists() {
            return Ok(Config {
                servers: Map::new(),
                threads: Map::new(),
                wake: None,
            });
        }
        let text = read_text(&path, "read the Parley config")?;
        let raw: Value = serde_json::from_str(&text).map_err(|_| {
            user_hint(
                format!("the Parley config {} is not valid JSON", path_str(&path)),
                "Fix it by hand, or move it aside and run `parley join '<room link>'` again (you get a new identity).",
            )
        })?;
        let Value::Object(mut raw) = raw else {
            return Err(user(format!("the Parley config {} is not a JSON object", path_str(&path))));
        };
        let take = |raw: &mut Map<String, Value>, key: &str| match raw.remove(key) {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        let servers = take(&mut raw, "servers");
        let threads = take(&mut raw, "threads");
        let wake = raw.remove("wake").filter(|w| !w.is_null() && w != &Value::Bool(false));
        Ok(Config { servers, threads, wake })
    }

    pub fn save(&self) -> Result<()> {
        let mut out = Map::new();
        out.insert("servers".into(), Value::Object(self.servers.clone()));
        out.insert("threads".into(), Value::Object(self.threads.clone()));
        if let Some(wake) = &self.wake {
            out.insert("wake".into(), wake.clone());
        }
        write_private(&config_path(), &Value::Object(out))
    }

    pub fn token(&self, server: &str) -> Option<String> {
        self.servers
            .get(server)
            .and_then(|e| e.get("token"))
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    pub fn address(&self, server: &str) -> Option<String> {
        self.servers
            .get(server)
            .and_then(|e| e.get("address"))
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    pub fn thread_server(&self, id: &str) -> Option<String> {
        self.threads
            .get(id)
            .and_then(|t| t.get("server"))
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    pub fn thread_title(&self, id: &str) -> Option<String> {
        self.threads
            .get(id)
            .and_then(|t| t.get("title"))
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    /// Drops removed rooms so nothing keeps asking about them.
    pub fn forget_rooms(ids: &[String]) -> Result<()> {
        let mut cfg = Config::load()?;
        let mut changed = false;
        for id in ids {
            if cfg.threads.shift_remove(id).is_some() {
                changed = true;
            }
        }
        if changed {
            cfg.save()?;
        }
        Ok(())
    }
}

/// Which servers and rooms matter to a session working in `cwd`: rooms bound to that directory (or a
/// parent) plus unbound ones. `None` for a server means every room there.
pub type Targets = Vec<(String, Option<Vec<String>>)>;

pub fn scope(cfg: &Config, cwd: &Path, all: bool) -> Targets {
    let mut out: Targets = Vec::new();
    if all {
        for server in cfg.servers.keys() {
            out.push((server.clone(), None));
        }
        return out;
    }
    let cwd = path_str(&canonical(cwd));
    for (id, t) in &cfg.threads {
        let server = t.get("server").and_then(Value::as_str).unwrap_or("");
        if !cfg.servers.contains_key(server) {
            continue;
        }
        if let Some(dir) = t.get("dir").and_then(Value::as_str) {
            if !in_dir(&cwd, &path_str(&canonical(Path::new(dir)))) {
                continue;
            }
        }
        match out.iter_mut().find(|(s, _)| s == server) {
            Some((_, Some(list))) => list.push(id.clone()),
            _ => out.push((server.to_string(), Some(vec![id.clone()]))),
        }
    }
    out
}

/// The rooms `parley say` with no room named could mean from `cwd`: those connected to it, else every room.
pub fn default_rooms(cfg: &Config, cwd: &Path) -> Vec<(String, Value)> {
    let cwd = path_str(&canonical(cwd));
    let all: Vec<(String, Value)> = cfg
        .threads
        .iter()
        .filter(|(_, t)| cfg.servers.contains_key(t.get("server").and_then(Value::as_str).unwrap_or("")))
        .map(|(id, t)| (id.clone(), t.clone()))
        .collect();
    let here: Vec<(String, Value)> = all
        .iter()
        .filter(|(_, t)| match t.get("dir").and_then(Value::as_str) {
            Some(dir) => in_dir(&cwd, &path_str(&canonical(Path::new(dir)))),
            None => false,
        })
        .cloned()
        .collect();
    if here.is_empty() {
        all
    } else {
        here
    }
}

// ---- per-session state ----------------------------------------------------

/// What one Claude Code session remembers between hook runs and commands.
#[derive(Default)]
pub struct Session {
    /// Pid of the waiter that currently owns this session. Older waiters stand down.
    pub pid: Option<u64>,
    /// Per room, the highest seq this session was already told about.
    pub notified: Map<String, Value>,
    /// Servers whose refusal of this agent's credentials the session was already woken about.
    pub auth_warned: Option<Vec<String>>,
    /// Per room, this session's own read mark.
    pub read: Option<Map<String, Value>>,
}

pub fn session_path(id: &str) -> PathBuf {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    parley_home().join("sessions").join(format!("{safe}.json"))
}

impl Session {
    pub fn load(id: &str) -> Session {
        let Ok(text) = std::fs::read_to_string(session_path(id)) else {
            return Session::default();
        };
        let Ok(Value::Object(raw)) = serde_json::from_str::<Value>(&text) else {
            return Session::default();
        };
        Session {
            pid: raw.get("pid").and_then(Value::as_u64),
            notified: raw.get("notified").and_then(Value::as_object).cloned().unwrap_or_default(),
            auth_warned: raw
                .get("authWarned")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()),
            read: raw.get("read").and_then(Value::as_object).cloned(),
        }
    }

    pub fn save(&self, id: &str) -> Result<()> {
        let mut out = Map::new();
        if let Some(pid) = self.pid {
            out.insert("pid".into(), json!(pid));
        }
        out.insert("notified".into(), Value::Object(self.notified.clone()));
        if let Some(warned) = &self.auth_warned {
            out.insert("authWarned".into(), json!(warned));
        }
        if let Some(read) = &self.read {
            out.insert("read".into(), Value::Object(read.clone()));
        }
        write_private(&session_path(id), &Value::Object(out))
    }
}

/// `JSON.stringify(seen)` in the order the map holds, for debugging output.
#[allow(dead_code)]
pub fn describe(v: &Map<String, Value>) -> String {
    pretty(&Value::Object(v.clone()))
}
