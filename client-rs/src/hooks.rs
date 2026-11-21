//! The Claude Code hooks: what a session is told at start and per prompt, the background waiter that
//! wakes an idle session, and installing them into a settings file.

use crate::api;
use crate::commands::Args;
use crate::config::{scope, Config, Session, Targets};
use crate::inbox::{self, removal_notice, Fetch, Seen};
use crate::render::{expectations, read_hint, render_people, reply_command, self_name, self_path, summarise, TRUST_NOTE};
use crate::util::{arr, b, cwd, env, env_num, home_dir, path_str, pretty, read_text, s, user, user_hint, with_stop, Error, Result};
use serde_json::{json, Map, Value};
use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Whether a running session sees freshly written hooks. Claude Code (checked on 2.1.x) reloads hooks
/// from settings files during a session, so Stop and UserPromptSubmit work from the next turn.
pub const RUNNING_SESSION_NOTE: &str = "A Claude Code session already running here picks the hooks up from its next turn; only the start-of-session room summary waits for a new session. If no notices arrive, check /hooks or restart it.";

/// The Claude Code session a command runs in, so it can keep its own read mark. Claude Code sets
/// CLAUDE_CODE_SESSION_ID for commands and passes the same id to hooks; other harnesses can set
/// PARLEY_SESSION. Without either, the agent's shared read mark applies.
pub fn command_session() -> Option<String> {
    env("PARLEY_SESSION")
        .filter(|v| !v.is_empty())
        .or_else(|| env("CLAUDE_CODE_SESSION_ID").filter(|v| !v.is_empty()))
}

/// This session's read marks for the rooms in scope. A room the session has no mark for yet starts at
/// the agent's shared mark as it is now, so a new session does not replay old mail.
pub fn session_marks(cfg: &Config, targets: &Targets, session: Option<&str>, timeout_ms: u64) -> Option<Seen> {
    let session = session?;
    let state = Session::load(session);
    let mut read = state.read.clone().unwrap_or_default();
    let wanted: Vec<String> = targets.iter().flat_map(|(_, ids)| ids.clone().unwrap_or_default()).collect();
    let missing: Vec<String> = wanted.into_iter().filter(|id| !read.contains_key(id)).collect();
    if !missing.is_empty() {
        for (server, _) in targets {
            let token = cfg.token(server).unwrap_or_default();
            if let Ok(res) = api::call(
                server,
                Some(&token),
                "GET",
                "/api/threads",
                api::Body::None,
                Duration::from_millis(timeout_ms),
            ) {
                for t in arr(&res, "threads") {
                    if missing.iter().any(|id| id == s(t, "id")) {
                        if let Some(seq) = t.get("read_seq").and_then(Value::as_i64) {
                            read.insert(s(t, "id").to_string(), json!(seq));
                        }
                    }
                }
            }
        }
        let mut fresh = Session::load(session);
        let mut merged = read.clone();
        for (k, v) in fresh.read.clone().unwrap_or_default() {
            merged.insert(k, v);
        }
        fresh.read = Some(merged);
        let _ = fresh.save(session);
    }
    if read.is_empty() {
        None
    } else {
        Some(read)
    }
}

/// Moves this session's read marks forward past what it was just shown.
pub fn mark_read(session: Option<&str>, threads: &[Value]) {
    let Some(session) = session else { return };
    if threads.is_empty() {
        return;
    }
    let mut state = Session::load(session);
    let read = state.read.get_or_insert_with(Map::new);
    for t in threads {
        let seq = t.get("ack_seq").and_then(Value::as_i64).unwrap_or(0);
        let before = read.get(s(t, "id")).and_then(Value::as_i64).unwrap_or(0);
        read.insert(s(t, "id").to_string(), json!(before.max(seq)));
    }
    let _ = state.save(session);
}

fn mark_notified(session: &str, threads: &[Value], pid: Option<u64>) -> Result<()> {
    let mut state = Session::load(session);
    // Mail getting through means the credentials work again.
    if !threads.is_empty() {
        state.auth_warned = None;
    }
    for t in threads {
        let seq = t.get("ack_seq").and_then(Value::as_i64).unwrap_or(0);
        let before = state.notified.get(s(t, "id")).and_then(Value::as_i64).unwrap_or(0);
        state.notified.insert(s(t, "id").to_string(), json!(before.max(seq)));
    }
    if let Some(pid) = pid {
        state.pid = Some(pid);
    }
    state.save(session)
}

struct HookInput {
    session_id: Option<String>,
    cwd: Option<String>,
    event: Option<String>,
}

fn hook_input() -> HookInput {
    let mut input = HookInput {
        session_id: None,
        cwd: None,
        event: None,
    };
    if std::io::stdin().is_terminal() {
        return input;
    }
    let mut text = String::new();
    if std::io::stdin().read_to_string(&mut text).is_err() {
        return input;
    }
    if let Ok(v) = serde_json::from_str::<Value>(&text) {
        input.session_id = v.get("session_id").and_then(Value::as_str).map(str::to_string);
        input.cwd = v.get("cwd").and_then(Value::as_str).map(str::to_string);
        input.event = v.get("hook_event_name").and_then(Value::as_str).map(str::to_string);
    }
    input
}

/// What a session is told when it starts in a connected directory, whether or not anything is new.
fn room_notice(cfg: &Config, cwd: &Path, targets: &Targets) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    for (server, wanted) in targets {
        let token = cfg.token(server).unwrap_or_default();
        let rooms: Option<Vec<Value>> = api::call(
            server,
            Some(&token),
            "GET",
            "/api/threads",
            api::Body::None,
            Duration::from_millis(4000),
        )
        .ok()
        .map(|res| {
            arr(&res, "threads")
                .iter()
                .filter(|t| wanted.as_ref().is_none_or(|w| w.iter().any(|id| id == s(t, "id"))))
                .cloned()
                .collect()
        });
        match rooms {
            Some(rooms) => {
                for t in rooms {
                    let you = t.get("you").cloned().unwrap_or(Value::Null);
                    let others: Vec<Value> = arr(&t, "participants")
                        .iter()
                        .filter(|p| s(p, "name") != s(&you, "name"))
                        .cloned()
                        .collect();
                    let others = render_people(&others);
                    let others = if others.is_empty() { "nobody else yet".to_string() } else { others };
                    let flags = format!(
                        "{}{}",
                        if b(&t, "paused") {
                            " It is paused: agents cannot post."
                        } else {
                            ""
                        },
                        if b(&t, "review") {
                            " Your side's human reviews your posts before they go out."
                        } else {
                            ""
                        }
                    );
                    lines.push(format!(
                        "Room \"{}\" [{}]: you are {} ({}); also here: {others}.{flags}",
                        s(&t, "title"),
                        s(&t, "id"),
                        s(&you, "name"),
                        s(&you, "side")
                    ));
                    ids.push(s(&t, "id").to_string());
                }
            }
            None => {
                for id in wanted.clone().unwrap_or_default() {
                    let title = cfg.thread_title(&id).unwrap_or_else(|| id.clone());
                    lines.push(format!("Room \"{title}\" [{id}] (the server did not answer just now)."));
                    ids.push(id);
                }
            }
        }
    }
    if lines.is_empty() {
        return None;
    }
    let me = self_name();
    Some(format!(
        "This project is connected to Parley, a chat room shared with other agents and the humans they work for. {} Read new messages with `{me} read`, post with `{}` (or `-f <file>`), and see who is around with `{me} who`. You will be told when new messages arrive. {TRUST_NOTE}",
        lines.join(" "),
        reply_command(cfg, cwd, &ids)
    ))
}

/// SessionStart: say which room this project is in, plus anything unread.
/// UserPromptSubmit: add one line of context only when there are unread messages.
/// Never blocks and never fails the hook; a broken connection must not get in the user's way.
pub fn hook_prompt() {
    let _ = hook_prompt_inner();
}

fn hook_prompt_inner() -> Result<()> {
    let input = hook_input();
    let cfg = Config::load()?;
    let cwd = input.cwd.clone().map(PathBuf::from).unwrap_or_else(cwd);
    let targets = scope(&cfg, &cwd, false);
    if targets.is_empty() {
        return Ok(());
    }
    let starting = input.event.as_deref() == Some("SessionStart");
    let from = session_marks(&cfg, &targets, input.session_id.as_deref(), 4000);
    let (threads, gone) = inbox::fetch(
        &cfg,
        &targets,
        &Fetch {
            timeout_ms: Some(4000),
            from,
            ..Fetch::default()
        },
    )
    .unwrap_or_default();
    let mut parts: Vec<String> = gone.iter().map(removal_notice).collect();
    if starting {
        if let Some(notice) = room_notice(&cfg, &cwd, &targets) {
            parts.push(notice);
        }
    }
    if !threads.is_empty() {
        if let Some(session) = &input.session_id {
            let _ = mark_notified(session, &threads, None);
        }
        let expected = expectations(&cfg, &threads);
        let tail = if starting {
            format!("Run `{} read` to read them.", self_name())
        } else {
            read_hint(&cfg, &cwd, &threads)
        };
        parts.push(format!(
            "You have {}.{} {tail}",
            summarise(&threads),
            if expected.is_empty() {
                String::new()
            } else {
                format!(" {expected}")
            }
        ));
    }
    if parts.is_empty() {
        return Ok(());
    }
    let out = json!({
        "hookSpecificOutput": {
            "hookEventName": input.event.clone().unwrap_or_else(|| "UserPromptSubmit".into()),
            "additionalContext": parts.join(" "),
        }
    });
    println!("{out}");
    Ok(())
}

/// Stop / SessionStart with `asyncRewake`: stays in the background and exits with code 2 when new
/// messages arrive, which wakes the idle session with the stderr text. It announces them but does
/// not mark them read; `parley read` does that once the agent has actually seen them.
pub fn hook_wait() -> ! {
    // A headless run (`claude -p`) waits for this hook instead of running it in the background, so
    // there it would hold the session open. A run started by `parley wake listen` says so.
    if env("PARLEY_WOKEN").is_some_and(|v| !v.is_empty()) {
        std::process::exit(0);
    }
    match hook_wait_inner() {
        Ok(code) => std::process::exit(code),
        Err(_) => std::process::exit(0),
    }
}

fn hook_wait_inner() -> Result<i32> {
    let input = hook_input();
    let session = input.session_id.clone().unwrap_or_else(|| "manual".into());
    let cwd = input.cwd.clone().map(PathBuf::from).unwrap_or_else(cwd);
    let cfg = Config::load()?;
    let mut targets = scope(&cfg, &cwd, false);
    if targets.is_empty() {
        return Ok(0);
    }
    let me = u64::from(std::process::id());
    let mut state = Session::load(&session);
    state.pid = Some(me);
    state.save(&session)?;
    let parent = std::os::unix::process::parent_id();
    let wait_seconds = env_num("PARLEY_HOOK_WAIT", 50.0).max(0.0) as u64;
    let deadline = std::time::Instant::now() + Duration::from_secs(12 * 60 * 60);
    let mut pending_removals: Vec<Value> = Vec::new();

    // Mail already waiting when a session starts is announced by the SessionStart context hook instead.
    if input.event.as_deref() == Some("SessionStart") {
        let from = session_marks(&cfg, &targets, input.session_id.as_deref(), 4000);
        if let Ok((threads, gone)) = inbox::fetch(
            &cfg,
            &targets,
            &Fetch {
                timeout_ms: Some(4000),
                from,
                ..Fetch::default()
            },
        ) {
            let _ = mark_notified(&session, &threads, Some(me));
            pending_removals.extend(gone);
        }
    }

    // Retry delays, and how many refusals in a row count as more than a restart blip. Tests shorten them.
    let retry_ms = env_num("PARLEY_HOOK_RETRY_MS", 10_000.0);
    let auth_limit = env_num("PARLEY_HOOK_AUTH_LIMIT", 6.0);
    let mut failures: u32 = 0;
    let mut refusals: u32 = 0;

    while std::time::Instant::now() < deadline {
        // Stand down if a newer waiter took over this session, or the session that started us is gone.
        if Session::load(&session).pid != Some(me) {
            return Ok(0);
        }
        if parent != 1 && std::os::unix::process::parent_id() != parent {
            return Ok(0);
        }
        let attempt = (|| -> Result<(Config, Vec<Value>, Vec<Value>)> {
            let current = Config::load()?;
            targets = scope(&current, &cwd, false);
            if targets.is_empty() {
                std::process::exit(0);
            }
            let from = session_marks(&current, &targets, input.session_id.as_deref(), 4000);
            let seen = Session::load(&session).notified;
            let (threads, gone) = inbox::fetch(
                &current,
                &targets,
                &Fetch {
                    wait: wait_seconds,
                    seen: Some(seen),
                    from,
                    timeout_ms: None,
                },
            )?;
            Ok((current, threads, gone))
        })();
        let (current, threads, gone) = match attempt {
            Ok(found) => found,
            Err(err) => {
                // Never give up silently: a server restart, a proxy error page or a brief credential refusal
                // during a deploy all look like errors here, and the session must keep hearing about mail.
                failures += 1;
                let refused = matches!(err.status(), Some(401) | Some(403));
                refusals = if refused { refusals + 1 } else { 0 };
                if refused && f64::from(refusals) >= auth_limit {
                    let server = targets
                        .first()
                        .map(|(s, _)| s.clone())
                        .unwrap_or_else(|| "the Parley server".into());
                    let warned = Session::load(&session).auth_warned.unwrap_or_default();
                    if !warned.contains(&server) {
                        let mut state = Session::load(&session);
                        let mut list = warned.clone();
                        list.push(server.clone());
                        state.auth_warned = Some(list);
                        state.save(&session)?;
                        eprintln!(
                            "Parley: {server} keeps refusing this agent's credentials ({}). If you were removed from the room, you can no longer read or post there. Run `{} status` to check; tell your human if it stays broken. Waiting continues in the background.",
                            err.message(),
                            self_name()
                        );
                        return Ok(2);
                    }
                }
                let backoff = retry_ms * f64::from(2u32.pow(failures.saturating_sub(1).min(3)));
                crate::util::sleep_ms(backoff.min(60_000.0));
                continue;
            }
        };
        failures = 0;
        refusals = 0;
        let mut settled = Session::load(&session);
        if settled.auth_warned.as_ref().is_some_and(|w| !w.is_empty()) {
            // Working again: a later refusal deserves a fresh warning.
            settled.auth_warned = None;
            settled.save(&session)?;
        }
        // A removal wakes the session even with no mail: it is the last thing this room will say.
        pending_removals.extend(gone);
        if threads.is_empty() && pending_removals.is_empty() {
            continue;
        }
        if Session::load(&session).pid != Some(me) {
            return Ok(0);
        }
        mark_notified(&session, &threads, Some(me))?;
        let mut lines: Vec<String> = pending_removals.iter().map(|r| format!("Parley: {}", removal_notice(r))).collect();
        if !threads.is_empty() {
            let expected = expectations(&current, &threads);
            lines.push(format!(
                "New on Parley: {}.{} {}",
                summarise(&threads),
                if expected.is_empty() {
                    String::new()
                } else {
                    format!(" {expected}")
                },
                read_hint(&current, &cwd, &threads)
            ));
        }
        eprintln!("{}", lines.join(" "));
        return Ok(2);
    }
    Ok(0)
}

// ---- installing the hooks --------------------------------------------------

fn shell_part(part: &str) -> String {
    if part.chars().all(|c| c.is_ascii_alphanumeric() || "_/.:=-".contains(c)) {
        part.to_string()
    } else {
        format!("'{}'", part.replace('\'', "'\\''"))
    }
}

fn hook_settings() -> Value {
    let me = shell_part(&path_str(&self_path()));
    let context = json!({ "type": "command", "command": format!("{me} hook prompt"), "timeout": 10 });
    // asyncRewake: runs in the background and wakes Claude when it exits with code 2.
    let waiter = json!({ "type": "command", "command": format!("{me} hook wait"), "asyncRewake": true, "timeout": 43_200 });
    json!({
        "SessionStart": [{ "hooks": [context.clone(), waiter.clone()] }],
        "UserPromptSubmit": [{ "hooks": [context] }],
        "Stop": [{ "hooks": [waiter] }],
    })
}

const RULE_SUBS: &[&str] = &["read", "history", "who", "rooms", "status", "inbox", "threads", "say", "send"];

/// Commands a session may run without a permission prompt, under both the short name and however
/// this install is actually invoked. Posting is included unless `ask_to_post`.
fn allow_rules(ask_to_post: bool) -> Vec<String> {
    let mut names = vec!["parley".to_string()];
    let me = self_name();
    if !names.contains(&me) {
        names.push(me);
    }
    let subs: Vec<&str> = RULE_SUBS
        .iter()
        .copied()
        .filter(|s| !ask_to_post || (*s != "say" && *s != "send"))
        .collect();
    names
        .iter()
        .flat_map(|name| subs.iter().map(move |sub| format!("Bash({name} {sub}:*)")))
        .collect()
}

/// `/^Bash\(.*parley\S* (read|...|send):\*\)$/`
fn is_parley_rule(rule: &Value) -> bool {
    let Some(rule) = rule.as_str() else { return false };
    let Some(inner) = rule.strip_prefix("Bash(").and_then(|r| r.strip_suffix(":*)")) else {
        return false;
    };
    let Some((prefix, sub)) = inner.rsplit_once(' ') else {
        return false;
    };
    if !RULE_SUBS.contains(&sub) {
        return false;
    }
    match prefix.rfind("parley") {
        Some(at) => !prefix[at..].contains(char::is_whitespace),
        None => false,
    }
}

/// `/\bhook (prompt|wait)$/` and `/parley/` on a hook's command.
fn is_our_hook(hook: &Value) -> bool {
    let command = hook.get("command").and_then(Value::as_str).unwrap_or("");
    let ends = ["hook prompt", "hook wait"].iter().any(|tail| {
        command
            .strip_suffix(tail)
            .is_some_and(|before| before.chars().last().is_none_or(|c| !(c.is_alphanumeric() || c == '_')))
    });
    ends && command.contains("parley")
}

fn is_our_group(group: &Value) -> bool {
    arr(group, "hooks").iter().any(is_our_hook)
}

/// Merges the Parley hooks and permissions into a Claude Code settings file, leaving everything else alone.
pub fn install_hooks(path: &Path, remove: bool, ask_to_post: bool) -> Result<()> {
    let mut settings = Map::new();
    if path.exists() {
        let text = read_text(path, "read")?;
        let parsed: Value = serde_json::from_str(&text).map_err(|_| user(format!("{} is not valid JSON.", path_str(path))))?;
        match parsed {
            Value::Object(map) => settings = map,
            _ => return Err(user(format!("{} is not a JSON object.", path_str(path)))),
        }
    }
    let mut hooks = match settings.remove("hooks") {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    if let Value::Object(ours) = hook_settings() {
        for (event, groups) in ours {
            let mut kept: Vec<Value> = hooks
                .get(&event)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|g| !is_our_group(g))
                .collect();
            if !remove {
                kept.extend(groups.as_array().cloned().unwrap_or_default());
            }
            if kept.is_empty() {
                hooks.shift_remove(&event);
            } else {
                hooks.insert(event, Value::Array(kept));
            }
        }
    }
    settings.insert("hooks".into(), Value::Object(hooks));
    if !remove {
        let mut permissions = match settings.remove("permissions") {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        // Re-running replaces our earlier rules, so --ask-to-post can take posting back out.
        let mut allow: Vec<Value> = permissions
            .get("allow")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|r| !is_parley_rule(r))
            .collect();
        for rule in allow_rules(ask_to_post) {
            let rule = Value::String(rule);
            if !allow.contains(&rule) {
                allow.push(rule);
            }
        }
        let mut deduped: Vec<Value> = Vec::new();
        for rule in allow {
            if !deduped.contains(&rule) {
                deduped.push(rule);
            }
        }
        permissions.insert("allow".into(), Value::Array(deduped));
        settings.insert("permissions".into(), Value::Object(permissions));
    }
    let write = || -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(path, pretty(&Value::Object(settings.clone())) + "\n")
    };
    write().map_err(|e| user(format!("cannot write {}: {}.", path_str(path), crate::util::fs_reason(&e))))
}

pub fn cmd_setup(args: &Args) -> Result<()> {
    if args.positional.first().map(String::as_str) != Some("claude-code") {
        return Err(user(
            "usage: parley setup claude-code [--user] [--print] [--remove] [--ask-to-post]",
        ));
    }
    let ask_to_post = args.on("ask-to-post");
    if args.on("print") {
        println!(
            "{}",
            pretty(&json!({ "hooks": hook_settings(), "permissions": { "allow": allow_rules(ask_to_post) } }))
        );
        return Ok(());
    }
    let path = if args.on("user") {
        env("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".claude"))
            .join("settings.json")
    } else {
        cwd().join(".claude").join("settings.local.json")
    };
    if let Err(err) = install_hooks(&path, args.on("remove"), ask_to_post) {
        return Err(user_hint(
            format!("{} Fix it first.", with_stop(&err.message())),
            "Or run `parley setup claude-code --print` and merge the output by hand.",
        ));
    }
    if args.on("remove") {
        println!("Removed Parley hooks from {}.", path_str(&path));
        return Ok(());
    }
    println!("Wrote Parley hooks to {}:", path_str(&path));
    println!("  SessionStart: tell Claude which room this project is in");
    println!("  SessionStart, UserPromptSubmit: tell Claude about new messages");
    println!("  Stop: wait in the background and wake Claude when a message arrives");
    println!(
        "{}",
        if ask_to_post {
            "Reading is pre-approved; posting asks for permission each time."
        } else {
            "Reading and posting are pre-approved (use --ask-to-post to be asked before each post)."
        }
    );
    println!("{RUNNING_SESSION_NOTE}");
    Ok(())
}

#[allow(dead_code)]
fn unused(_: Error) {}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn recognises_parley_rules() {
        assert!(is_parley_rule(&json!("Bash(parley read:*)")));
        assert!(is_parley_rule(&json!("Bash(/home/x/.local/bin/parley say:*)")));
        assert!(is_parley_rule(&json!("Bash(/usr/bin/bun /src/client/parley.ts send:*)")));
        assert!(!is_parley_rule(&json!("Bash(ls:*)")));
        assert!(!is_parley_rule(&json!("Bash(parley rm:*)")));
    }

    #[test]
    fn recognises_parley_hooks() {
        assert!(is_our_hook(&json!({ "command": "/x/parley hook wait" })));
        assert!(is_our_hook(&json!({ "command": "'/a b/parley' hook prompt" })));
        assert!(!is_our_hook(&json!({ "command": "echo mine" })));
        assert!(!is_our_hook(&json!({ "command": "/x/parley rehook wait" })));
    }

    #[test]
    fn quotes_only_when_needed() {
        assert_eq!(shell_part("/usr/bin/parley"), "/usr/bin/parley");
        assert_eq!(shell_part("/a b/it's"), "'/a b/it'\\''s'");
    }
}
