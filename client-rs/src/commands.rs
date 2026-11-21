//! The commands an agent runs: new, join, read, say, who, history, transcript, rooms, watch, wake,
//! bind, status.

use crate::api::{self, Body};
use crate::config::{config_path, default_rooms, parley_home, scope, Config};
use crate::hooks::{command_session, install_hooks, mark_read, session_marks, RUNNING_SESSION_NOTE};
use crate::inbox::{self, removal_notice, Fetch};
use crate::render::{render_message, render_people, render_thread_mail, say_command, self_name, summarise, TRUST_NOTE};
use crate::util::{
    arr, b, canonical, cwd, env, env_num, i, js, js_number, path_str, pretty, random_hex, read_text, resolve, s, same_secret, user,
    user_hint, with_stop, Error, Result, Url,
};
use serde_json::{json, Map, Value};
use std::io::{IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

// ---- arguments -----------------------------------------------------------

#[derive(Clone)]
pub enum Flag {
    On,
    Value(String),
}

#[derive(Clone, Default)]
pub struct Args {
    pub positional: Vec<String>,
    pub flags: Vec<(String, Flag)>,
}

const BOOLEAN_FLAGS: &[&str] = &[
    "all",
    "peek",
    "json",
    "once",
    "user",
    "print",
    "global",
    "remove",
    "help",
    "no-hooks",
    "ask-to-post",
    "review",
    "fyi",
];

impl Args {
    pub fn parse(argv: &[String]) -> Args {
        let mut args = Args::default();
        let mut it = argv.iter();
        while let Some(arg) = it.next() {
            if arg == "-f" {
                args.set("file", Flag::Value(it.next().cloned().unwrap_or_default()));
            } else if let Some(name) = arg.strip_prefix("--") {
                let flag = if BOOLEAN_FLAGS.contains(&name) {
                    Flag::On
                } else {
                    Flag::Value(it.next().cloned().unwrap_or_default())
                };
                args.set(name, flag);
            } else {
                args.positional.push(arg.clone());
            }
        }
        args
    }
    fn set(&mut self, name: &str, flag: Flag) {
        match self.flags.iter_mut().find(|(n, _)| n == name) {
            Some((_, slot)) => *slot = flag,
            None => self.flags.push((name.to_string(), flag)),
        }
    }
    fn get(&self, name: &str) -> Option<&Flag> {
        self.flags.iter().find(|(n, _)| n == name).map(|(_, f)| f)
    }
    /// `args.flags.name === true`
    pub fn on(&self, name: &str) -> bool {
        matches!(self.get(name), Some(Flag::On))
    }
    /// `typeof args.flags.name === "string" ? args.flags.name : undefined`
    pub fn value(&self, name: &str) -> Option<&str> {
        match self.get(name) {
            Some(Flag::Value(v)) => Some(v),
            _ => None,
        }
    }
    /// `args.flags.name !== undefined`
    pub fn has(&self, name: &str) -> bool {
        self.get(name).is_some()
    }
    /// Truthy, as JavaScript sees `args.flags.name`.
    pub fn truthy(&self, name: &str) -> bool {
        match self.get(name) {
            Some(Flag::On) => true,
            Some(Flag::Value(v)) => !v.is_empty(),
            None => false,
        }
    }
}

// ---- rooms ---------------------------------------------------------------

pub struct Room {
    pub id: String,
    pub server: String,
    pub token: String,
}

/// True when `word` could name a joined room: a hex prefix of one of their ids.
fn is_room_ref(cfg: &Config, word: Option<&String>) -> bool {
    let Some(word) = word else { return false };
    (6..=16).contains(&word.len())
        && word.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        && cfg.threads.keys().any(|id| id.starts_with(word.as_str()))
}

/// Finds a room by id prefix, or, with no reference, the one room this directory is connected to.
pub fn resolve_room(cfg: &Config, reference: Option<&str>) -> Result<Room> {
    let id = match reference {
        Some(r) if !r.is_empty() => {
            let matches: Vec<&String> = cfg.threads.keys().filter(|id| id.starts_with(r)).collect();
            if matches.is_empty() {
                return Err(user_hint(
                    format!("no joined room matches \"{r}\""),
                    "Run `parley rooms` to list them.",
                ));
            }
            if matches.len() > 1 {
                return Err(user(format!(
                    "\"{r}\" matches several rooms: {}",
                    matches.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
                )));
            }
            matches[0].clone()
        }
        _ => {
            let pick = default_rooms(cfg, &cwd());
            if pick.is_empty() {
                return Err(user_hint("you are not in any room", "Join one with `parley join '<room link>'`."));
            }
            if pick.len() > 1 {
                return Err(user_hint(
                    "more than one room fits here, so say which",
                    pick.iter()
                        .map(|(room, t)| format!("{room}  \"{}\"", s(t, "title")))
                        .collect::<Vec<_>>()
                        .join("\n  "),
                ));
            }
            pick[0].0.clone()
        }
    };
    let server = cfg.thread_server(&id).unwrap_or_default();
    let Some(token) = cfg.token(&server) else {
        return Err(user_hint(
            format!("no identity stored for {server}"),
            "Run `parley join '<room link>'` again.",
        ));
    };
    Ok(Room { id, server, token })
}

const NOT_JOINED: &str = "You are not in any room yet. Join one with `parley join '<room link>'`.";
const NO_ROOMS_HERE: &str = "No Parley rooms are connected to this directory. Use --all to see every room.";

// ---- new and join --------------------------------------------------------

/// The server to create rooms on: the one named, else the only one known, else the one the client was installed from.
fn default_server(cfg: &Config, named: Option<&str>) -> Result<String> {
    let pick = match named {
        Some(n) if !n.is_empty() => Some(n.to_string()),
        _ => env("PARLEY_URL").filter(|u| !u.is_empty()),
    };
    if let Some(pick) = pick {
        return Url::parse(&pick)
            .map(|u| u.origin())
            .ok_or_else(|| user_hint(format!("\"{pick}\" is not a server URL"), "It looks like https://<host>"));
    }
    let known: Vec<&String> = cfg.servers.keys().collect();
    if known.len() == 1 {
        return Ok(known[0].clone());
    }
    let recorded = parley_home().join("server");
    if known.is_empty() && recorded.exists() {
        let text = read_text(&recorded, "read")?;
        if let Some(url) = Url::parse(text.trim()) {
            return Ok(url.origin());
        }
    }
    let message = if known.is_empty() {
        "no Parley server is known yet".to_string()
    } else {
        format!(
            "you use several Parley servers, so say which: {}",
            known.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
        )
    };
    Err(user_hint(message, "Pass --server https://<host>"))
}

const NEW_USAGE: &str = "usage: parley new \"<room name>\" --as <your side> --with <other side>[,<another>] [--server <url>] [--review]";

/// Creates a room, joins it on this agent's side, and prints the links to hand out.
pub fn cmd_new(args: &Args) -> Result<()> {
    let title = args.positional.join(" ").trim().to_string();
    let mine = args.value("as").map(str::trim).unwrap_or("").to_string();
    let others: Vec<String> = args
        .value("with")
        .map(|w| w.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect())
        .unwrap_or_default();
    if title.is_empty() || mine.is_empty() || others.is_empty() {
        return Err(user_hint(
            NEW_USAGE,
            "A side is a team or organisation, for example: parley new \"Billing API questions\" --as Vers --with Acme",
        ));
    }
    let cfg = Config::load()?;
    let server = default_server(&cfg, args.value("server"))?;
    let review = args.on("review");
    let sides: Vec<Value> = std::iter::once(&mine)
        .chain(others.iter())
        .map(|name| json!({ "name": name, "approval": review }))
        .collect();
    let token = cfg.token(&server);
    let res = api::post_json(&server, token.as_deref(), "/api/threads", json!({ "title": title, "sides": sides }))?;
    let sides = arr(&res, "sides");
    println!("Created room \"{title}\". Each side has one link: it opens the room in a browser and is what that side's agents join with.");
    let own = sides.first().cloned().unwrap_or(Value::Null);
    println!(
        "\n  {} (your side; give this to your human so they can watch):\n    {}",
        s(&own, "name"),
        s(&own, "human_url")
    );
    for side in sides.iter().skip(1) {
        println!(
            "\n  {} (send this to them privately; their agents run: parley join '<link>'):\n    {}",
            s(side, "name"),
            s(side, "human_url")
        );
    }
    println!("\nThese links are not shown again, and whoever holds one acts for that side.\n");
    let mut join = args.clone();
    join.positional = vec![s(&own, "human_url").to_string()];
    cmd_join(&join)
}

pub fn cmd_join(args: &Args) -> Result<()> {
    let Some(raw) = args.positional.first() else {
        return Err(user(
            "usage: parley join '<room link>' [--label <name>] [--global] [--no-hooks] [--ask-to-post]",
        ));
    };
    let Some(url) = Url::parse(raw) else {
        return Err(user_hint(
            "that is not a room link",
            "It looks like https://<host>/t#ph_...  Quote it in single quotes so the shell keeps the part after #.",
        ));
    };
    // The part after # is the room link's token, or a one-time invite code.
    let code = url.fragment.clone();
    if code.is_empty() {
        return Err(user_hint(
            "the link has nothing after '#'",
            "Quote the link in single quotes so the shell keeps the part after #.",
        ));
    }
    let server = url.origin();
    let mut cfg = Config::load()?;
    let existing = cfg.token(&server);
    let mut body = Map::new();
    body.insert("code".into(), json!(code));
    if let Some(label) = args.value("label") {
        body.insert("label".into(), json!(label));
    }
    let res = api::post_json(&server, existing.as_deref(), "/api/join", Value::Object(body))?;
    let mailbox = res.get("mailbox").cloned().unwrap_or(Value::Null);
    if let Some(token) = mailbox.get("token").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        cfg.servers
            .insert(server.clone(), json!({ "token": token, "address": s(&mailbox, "address") }));
    }
    let thread = res.get("thread").cloned().unwrap_or(Value::Null);
    let dir = if args.on("global") {
        Value::Null
    } else {
        json!(path_str(&canonical(&cwd())))
    };
    cfg.threads.insert(
        s(&thread, "id").to_string(),
        json!({ "server": server, "title": s(&thread, "title"), "dir": dir }),
    );
    cfg.save()?;

    let you = thread.get("you").cloned().unwrap_or(Value::Null);
    let me = self_name();
    println!(
        "Joined room \"{}\" [room {}] as {} ({}).",
        s(&thread, "title"),
        s(&thread, "id"),
        s(&you, "name"),
        s(&you, "side")
    );
    println!(
        "Your identity on {server} is {}{}, stored in {}.",
        s(&mailbox, "address"),
        if existing.is_some() { " (existing)" } else { " (new)" },
        path_str(&config_path())
    );
    if args.on("no-hooks") {
        println!("Claude Code was not set up. Run `{me} setup claude-code` here to be told about new messages.");
    } else {
        let path = cwd().join(".claude").join("settings.local.json");
        match install_hooks(&path, false, args.on("ask-to-post")) {
            Ok(()) => {
                println!(
                    "Claude Code sessions started in {} now know about this room and are told about new messages (hooks in {}).",
                    path_str(&cwd()),
                    path_str(&path)
                );
                println!("{RUNNING_SESSION_NOTE}");
            }
            Err(err) => println!(
                "Could not set up Claude Code here: {} Run `{me} setup claude-code` once that is fixed.",
                with_stop(&err.message())
            ),
        }
    }
    if b(&thread, "review") {
        println!("A human on your side reviews your messages before they are posted.");
    }
    let participants = arr(&res, "participants");
    println!("Here: {}", render_people(participants));
    if let Some(human) = participants
        .iter()
        .find(|p| s(p, "kind") == "human" && s(p, "side") == s(&you, "side"))
    {
        if s(human, "state") == "not_joined" {
            if b(&thread, "review") {
                println!("{} has not opened the room yet. Because your posts need their approval, nothing you say goes out until they open your side's link in a browser.", s(human, "name"));
            } else {
                println!("{} has not opened the room yet. Nothing is needed from them for you to take part; they open your side's link in a browser when they want to watch or step in.", s(human, "name"));
            }
        }
    }
    let recent = arr(&res, "recent");
    if !recent.is_empty() {
        println!("\nThe room so far. {TRUST_NOTE}");
        for m in recent {
            println!("{}", render_message(m));
        }
    }
    println!(
        "\nRead new messages: {me} read     Post: {}     Who is around: {me} who",
        say_command(&cfg, &cwd(), s(&thread, "id"))
    );
    Ok(())
}

// ---- read and watch ------------------------------------------------------

/// Prints messages this agent has not seen yet and marks them read.
pub fn cmd_read(args: &Args) -> Result<()> {
    let cfg = Config::load()?;
    let targets = scope(&cfg, &cwd(), args.on("all"));
    let wait = args
        .value("wait")
        .and_then(js_number)
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n as u64)
        .unwrap_or(0);
    let session = command_session();
    let from = session_marks(&cfg, &targets, session.as_deref(), 4000);
    let (threads, gone) = inbox::fetch(
        &cfg,
        &targets,
        &Fetch {
            wait,
            from,
            ..Fetch::default()
        },
    )?;
    if args.on("json") {
        println!("{}", pretty(&json!({ "threads": threads, "removed": gone })));
    } else if threads.is_empty() && !gone.is_empty() {
        println!("{}", gone.iter().map(removal_notice).collect::<Vec<_>>().join("\n"));
    } else if threads.is_empty() {
        println!("{}", if targets.is_empty() { NO_ROOMS_HERE } else { "No new messages." });
    } else {
        if !gone.is_empty() {
            println!("{}\n", gone.iter().map(removal_notice).collect::<Vec<_>>().join("\n"));
        }
        println!("{}\n{TRUST_NOTE}\n", summarise(&threads));
        println!(
            "{}",
            threads
                .iter()
                .map(|t| render_thread_mail(&cfg, &cwd(), t))
                .collect::<Vec<_>>()
                .join("\n\n")
        );
    }
    // Printing is delivery: the agent now has the messages in its context.
    if !args.on("peek") && !threads.is_empty() {
        mark_read(session.as_deref(), &threads);
        inbox::ack(&cfg, &threads)?;
    }
    Ok(())
}

pub fn cmd_watch(args: &Args) -> Result<()> {
    let all = args.on("all");
    if scope(&Config::load()?, &cwd(), all).is_empty() {
        return Err(user_hint(
            "no Parley rooms are connected to this directory",
            "Use --all to watch every room.",
        ));
    }
    loop {
        // Rooms can be forgotten mid-watch (a removal), so the scope is worked out afresh each time.
        let cfg = Config::load()?;
        let targets = scope(&cfg, &cwd(), all);
        if targets.is_empty() {
            println!("No Parley rooms are connected to this directory any more.");
            return Ok(());
        }
        let from = session_marks(&cfg, &targets, command_session().as_deref(), 4000);
        let (threads, gone) = match inbox::fetch(
            &cfg,
            &targets,
            &Fetch {
                wait: 240,
                from,
                ..Fetch::default()
            },
        ) {
            Ok(found) => found,
            Err(err) => {
                if err.status() == Some(401) {
                    return Err(err);
                }
                std::thread::sleep(Duration::from_secs(5));
                continue;
            }
        };
        if !gone.is_empty() {
            println!("{}", gone.iter().map(removal_notice).collect::<Vec<_>>().join("\n"));
        }
        if threads.is_empty() {
            if !gone.is_empty() && args.on("once") {
                return Ok(());
            }
            continue;
        }
        let text = format!(
            "{}\n{TRUST_NOTE}\n\n{}\n",
            summarise(&threads),
            threads
                .iter()
                .map(|t| render_thread_mail(&cfg, &cwd(), t))
                .collect::<Vec<_>>()
                .join("\n\n")
        );
        if let Some(command) = args.value("exec") {
            // Hand the batch to another harness. Only a command that succeeds counts as delivery, so mail
            // a failed hand-off carried stays unread and comes round again.
            let code = hand_off(command, &text, &threads);
            if code != 0 {
                eprintln!("parley: the --exec command exited with {code}; the messages stay unread and will be handed off again.");
                if args.on("once") {
                    std::process::exit(1);
                }
                crate::util::sleep_ms(env_num("PARLEY_EXEC_RETRY_MS", 30_000.0));
                continue;
            }
        } else {
            println!("{text}");
        }
        mark_read(command_session().as_deref(), &threads);
        inbox::ack(&cfg, &threads)?;
        if args.on("once") {
            return Ok(());
        }
    }
}

/// Runs `command` through the shell with the new messages on stdin, waiting for it to finish, so one
/// harness turn handles one batch and mail arriving meanwhile becomes the next batch.
/// PARLEY_ROOMS carries the ids of the rooms the batch came from.
fn hand_off(command: &str, text: &str, threads: &[Value]) -> i32 {
    let rooms = threads.iter().map(|t| s(t, "id").to_string()).collect::<Vec<_>>().join(",");
    let child = std::process::Command::new("sh")
        .arg("-c")
        .arg(command)
        .env("PARLEY_ROOMS", rooms)
        .stdin(std::process::Stdio::piped())
        .spawn();
    let Ok(mut child) = child else { return 127 };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes());
    }
    child.wait().ok().and_then(|status| status.code()).unwrap_or(1)
}

// ---- say -----------------------------------------------------------------

/// `--to <agent-or-side>[,...]` wakes those now; `--fyi` wakes nobody; neither is a room-wide message.
fn audience(args: &Args) -> Result<Option<(String, Value)>> {
    let fyi = args.on("fyi");
    if !args.has("to") {
        return Ok(if fyi { Some(("fyi".into(), json!(true))) } else { None });
    }
    let to: Vec<String> = args
        .value("to")
        .map(|t| t.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect())
        .unwrap_or_default();
    if to.is_empty() {
        return Err(user_hint(
            "--to needs a name",
            "Use `--to <agent address or side>[,<another>]`. `parley who` lists who is in the room.",
        ));
    }
    if fyi {
        return Err(user_hint(
            "use --to or --fyi, not both",
            "--to wakes the agents named; --fyi wakes nobody.",
        ));
    }
    Ok(Some(("to".into(), json!(to))))
}

/// Posts a message. Plain text when no audience is given, so servers that predate addressing still accept it.
fn post(room: &Room, body: String, audience: Option<(String, Value)>) -> Result<Value> {
    let path = format!("/api/threads/{}/messages", room.id);
    let timeout = Duration::from_secs(30);
    match audience {
        None => api::call(&room.server, Some(&room.token), "POST", &path, Body::Text(body), timeout),
        Some((key, value)) => {
            let mut json = Map::new();
            json.insert("body".into(), json!(body));
            json.insert(key, value);
            api::call(
                &room.server,
                Some(&room.token),
                "POST",
                &path,
                Body::Json(Value::Object(json)),
                timeout,
            )
        }
    }
}

/// `parley say [room] <text>`, `parley say [room] -f <file>`, or the message on stdin.
pub fn cmd_say(args: &Args) -> Result<()> {
    let cfg = Config::load()?;
    let mut words = args.positional.clone();
    let file = args.value("file").map(str::to_string);
    let piped = !std::io::stdin().is_terminal();
    let mut reference: Option<String> = None;
    if is_room_ref(&cfg, words.first()) && (words.len() > 1 || file.is_some() || piped) {
        reference = Some(words.remove(0));
    }
    let room = resolve_room(&cfg, reference.as_deref())?;
    if file.as_deref() == Some("") {
        return Err(user_hint(
            "-f needs a file name",
            "Use `parley say -f <file>`, or `-f -` to read the message from stdin.",
        ));
    }
    let body = match file.as_deref() {
        Some(f) if f != "-" => read_text(Path::new(f), "read")?,
        _ if !words.is_empty() && file.as_deref() != Some("-") => words.join(" "),
        _ if piped => {
            let mut text = String::new();
            let _ = std::io::stdin().read_to_string(&mut text);
            text
        }
        _ => {
            return Err(user_hint(
                "no message given",
                "Use `parley say \"<text>\"`, `parley say -f <file>`, or pipe the message on stdin.",
            ))
        }
    };
    let res = post(&room, body, audience(args)?)?;
    let (first, note) = api::post_outcome(&res);
    println!("{first}");
    println!("{note}");
    Ok(())
}

// ---- reading a room ------------------------------------------------------

/// `parley transcript [room] [--json]`: the whole room as Markdown, or as JSON, on stdout.
pub fn cmd_transcript(args: &Args) -> Result<()> {
    let cfg = Config::load()?;
    let room = resolve_room(&cfg, args.positional.first().map(String::as_str))?;
    let path = format!(
        "/api/threads/{}/transcript{}",
        room.id,
        if args.truthy("json") { "?format=json" } else { "" }
    );
    let (status, text) = api::raw(&room.server, Some(&room.token), "GET", &path, Body::None, Duration::from_secs(30))?;
    if !(200..300).contains(&status) {
        let data: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        return Err(api::api_error(status, &data));
    }
    print!("{text}");
    let _ = std::io::stdout().flush();
    Ok(())
}

pub fn cmd_history(args: &Args) -> Result<()> {
    let cfg = Config::load()?;
    let room = resolve_room(&cfg, args.positional.first().map(String::as_str))?;
    let after = args.value("after").and_then(js_number).map(|n| n as i64).unwrap_or(0);
    let res = api::get(
        &room.server,
        &room.token,
        &format!("/api/threads/{}/messages?after={after}", room.id),
    )?;
    if args.truthy("json") {
        println!("{}", pretty(&res));
        return Ok(());
    }
    let info = res.get("thread").cloned().unwrap_or(Value::Null);
    let you = info.get("you").cloned().unwrap_or(Value::Null);
    let flag = if b(&info, "archived") {
        "  ** ARCHIVED **"
    } else if b(&info, "paused") {
        "  ** PAUSED **"
    } else {
        ""
    };
    println!(
        "== {}  [room {}]  you are {} ({}){flag}",
        s(&info, "title"),
        s(&info, "id"),
        s(&you, "name"),
        s(&you, "side")
    );
    println!("{TRUST_NOTE}");
    let mine = command_session()
        .and_then(|id| crate::config::Session::load(&id).read)
        .and_then(|read| read.get(&room.id).and_then(Value::as_i64));
    let read_to = mine.unwrap_or_else(|| i(&res, "read_seq"));
    for m in arr(&res, "messages") {
        let new = i(m, "seq") > read_to && s(m, "from") != s(&you, "name");
        println!("{}{}", render_message(m), if new { "   [new]" } else { "" });
    }
    let pending = arr(&res, "pending").len();
    if pending > 0 {
        println!("  ({pending} of your messages are waiting for your side's human to approve)");
    }
    println!("  Here: {}", render_people(arr(&res, "participants")));
    Ok(())
}

/// Every room this agent is in, fresh from the servers. Also records rooms it was seated in elsewhere.
fn fetch_rooms(cfg: &mut Config) -> Result<Vec<Value>> {
    let mut rows = Vec::new();
    let servers: Vec<(String, String)> = cfg.servers.keys().map(|k| (k.clone(), cfg.token(k).unwrap_or_default())).collect();
    for (server, token) in servers {
        let res = api::get(&server, &token, "/api/threads")?;
        for t in arr(&res, "threads") {
            let id = s(t, "id").to_string();
            if !cfg.threads.contains_key(&id) {
                cfg.threads
                    .insert(id.clone(), json!({ "server": server, "title": s(t, "title"), "dir": null }));
            }
            let mut row = t.clone();
            if let Value::Object(map) = &mut row {
                map.insert("server".into(), json!(server));
                map.insert(
                    "dir".into(),
                    cfg.threads.get(&id).and_then(|e| e.get("dir")).cloned().unwrap_or(Value::Null),
                );
            }
            rows.push(row);
        }
    }
    Ok(rows)
}

fn room_flag(t: &Value) -> &'static str {
    if b(t, "archived") {
        "  ARCHIVED"
    } else if b(t, "paused") {
        "  PAUSED"
    } else {
        ""
    }
}

pub fn cmd_rooms(args: &Args) -> Result<()> {
    let mut cfg = Config::load()?;
    if cfg.servers.is_empty() {
        println!("{NOT_JOINED}");
        return Ok(());
    }
    let rows = fetch_rooms(&mut cfg)?;
    cfg.save()?;
    if args.truthy("json") {
        println!("{}", pretty(&json!({ "threads": rows })));
        return Ok(());
    }
    if rows.is_empty() {
        println!("Not in any rooms.");
        return Ok(());
    }
    for t in &rows {
        let you = t.get("you").cloned().unwrap_or(Value::Null);
        println!(
            "{}  \"{}\"  {} new{}",
            s(t, "id"),
            s(t, "title"),
            js(t.get("unread_count")),
            room_flag(t)
        );
        println!("    you: {} ({}) on {}", s(&you, "name"), s(&you, "side"), s(t, "server"));
        println!(
            "    connected to: {}",
            t.get("dir").and_then(Value::as_str).unwrap_or("every directory")
        );
        println!("    here: {}", render_people(arr(t, "participants")));
    }
    Ok(())
}

/// Who is in the room(s) this directory is connected to, and whether they are around.
pub fn cmd_who(args: &Args) -> Result<()> {
    let mut cfg = Config::load()?;
    if cfg.servers.is_empty() {
        println!("{NOT_JOINED}");
        return Ok(());
    }
    let only = match args.positional.first() {
        Some(r) if !r.is_empty() => Some(resolve_room(&cfg, Some(r))?.id),
        _ => None,
    };
    let all = args.on("all");
    let targets = scope(&cfg, &cwd(), all);
    let rows: Vec<Value> = fetch_rooms(&mut cfg)?
        .into_iter()
        .filter(|t| match &only {
            Some(id) => s(t, "id") == id,
            None => {
                all || targets
                    .iter()
                    .any(|(server, ids)| server == s(t, "server") && ids.as_ref().is_some_and(|ids| ids.iter().any(|id| id == s(t, "id"))))
            }
        })
        .collect();
    if rows.is_empty() {
        println!("{NO_ROOMS_HERE}");
        return Ok(());
    }
    for t in &rows {
        let you = t.get("you").cloned().unwrap_or(Value::Null);
        println!("\"{}\" [room {}]{}", s(t, "title"), s(t, "id"), room_flag(t));
        for person in arr(t, "participants") {
            let state = match s(person, "state") {
                "listening" => "here now".to_string(),
                "not_joined" => "has not joined".to_string(),
                _ => format!("last active {}s ago", js(person.get("last_seen_seconds_ago"))),
            };
            let me = if s(person, "name") == s(&you, "name") { " <- you" } else { "" };
            println!(
                "  {} ({}, {}){me}: {state}",
                s(person, "name"),
                s(person, "side"),
                s(person, "kind")
            );
        }
    }
    Ok(())
}

pub fn cmd_bind(args: &Args) -> Result<()> {
    let mut cfg = Config::load()?;
    let Some(reference) = args.positional.first().filter(|r| !r.is_empty()) else {
        return Err(user_hint(
            "usage: parley bind <room> [dir] [--global]",
            "Run `parley rooms` to list them.",
        ));
    };
    let room = resolve_room(&cfg, Some(reference))?;
    let dir: Option<String> = if args.on("global") {
        None
    } else {
        let target = args.positional.get(1).map(PathBuf::from).unwrap_or_else(cwd);
        Some(path_str(&canonical(&resolve(&target))))
    };
    if let Some(Value::Object(entry)) = cfg.threads.get_mut(&room.id) {
        entry.insert("dir".into(), dir.clone().map(Value::String).unwrap_or(Value::Null));
    }
    cfg.save()?;
    match dir {
        Some(dir) => println!("Room {} is now connected to sessions working in {dir}.", room.id),
        None => println!("Room {} is now connected to every session.", room.id),
    }
    Ok(())
}

pub fn cmd_status() -> Result<()> {
    let cfg = Config::load()?;
    println!("parley {}   config: {}", crate::VERSION, path_str(&config_path()));
    if cfg.servers.is_empty() {
        println!("{NOT_JOINED}");
        return Ok(());
    }
    for (server, entry) in &cfg.servers {
        let address = s(entry, "address");
        match api::call(
            server,
            Some(s(entry, "token")),
            "GET",
            "/api/inbox",
            Body::None,
            Duration::from_millis(8000),
        ) {
            Ok(res) => {
                let n = i(&res, "unread_count");
                println!(
                    "{server}: you are {address}, reachable, {n} new message{}",
                    if n == 1 { "" } else { "s" }
                );
            }
            Err(err) => println!("{server}: you are {address}, NOT WORKING: {}", err.message()),
        }
    }
    let here = scope(&cfg, &cwd(), false);
    let count: usize = here.iter().map(|(_, ids)| ids.as_ref().map_or(0, Vec::len)).sum();
    println!(
        "{count} room{} connected to {}.",
        if count == 1 { "" } else { "s" },
        path_str(&cwd())
    );
    Ok(())
}

// ---- wake: starting an agent when nothing is running -----------------------

const WAKE_USAGE: &str =
    "usage: parley wake listen --url <public address of this machine> [--port 8787] [--exec '<command>'] | parley wake off | parley wake";

/// What a wake runs unless --exec says otherwise: one headless Claude Code turn in this directory.
fn default_wake_command() -> String {
    format!(
        "claude -p 'New Parley messages arrived while no session was running in this directory. Run `{} read` and answer what is addressed to you.'",
        self_name()
    )
}

/// Listens for the Parley server's wake call and starts an agent in this directory when it comes.
/// One run at a time: a call that arrives while a run is still going is acknowledged and dropped.
pub fn cmd_wake(args: &Args) -> Result<()> {
    let mut cfg = Config::load()?;
    let servers: Vec<(String, Value)> = cfg.servers.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    if servers.is_empty() {
        return Err(user(NOT_JOINED));
    }
    let sub = args.positional.first().cloned().unwrap_or_else(|| "status".into());
    if sub == "status" || sub == "off" {
        for (server, entry) in &servers {
            let token = s(entry, "token");
            let res = if sub == "off" {
                api::post_json(server, Some(token), "/api/wake", json!({ "url": null }))?
            } else {
                api::get(server, token, "/api/wake")?
            };
            match res.get("wake_url").and_then(Value::as_str) {
                Some(url) if !url.is_empty() => println!("{server}: wakes {} at {url}", s(entry, "address")),
                _ => println!("{server}: no wake address for {}", s(entry, "address")),
            }
        }
        if sub == "status" && !args.truthy("url") {
            println!("Set one with `parley wake listen --url <public address of this machine>`.");
        }
        return Ok(());
    }
    if sub != "listen" {
        return Err(user(WAKE_USAGE));
    }
    let raw_url = match args.value("url") {
        Some(u) if !u.is_empty() => u.to_string(),
        _ => return Err(user(WAKE_USAGE)),
    };
    let Some(base) = Url::parse(&raw_url) else {
        return Err(user_hint(
            format!("--url {raw_url} is not a URL"),
            "Give the address this machine is reached at from the internet, e.g. https://<computer-id>.vm.vers.sh:8787",
        ));
    };
    let port = match args.value("port") {
        None if !args.has("port") => 8787.0,
        other => js_number(other.unwrap_or("")).unwrap_or(f64::NAN),
    };
    if !(port.fract() == 0.0 && (1.0..=65535.0).contains(&port)) {
        return Err(user(format!("--port {} is not a port number", args.value("port").unwrap_or(""))));
    }
    let port = port as u16;
    let command = args
        .value("exec")
        .filter(|e| !e.is_empty())
        .map(str::to_string)
        .unwrap_or_else(default_wake_command);

    let secret = match cfg.wake.as_ref().and_then(|w| w.get("secret")).and_then(Value::as_str) {
        Some(secret) if !secret.is_empty() => secret.to_string(),
        _ => {
            let secret = random_hex(24)?;
            cfg.wake = Some(json!({ "secret": secret }));
            cfg.save()?;
            secret
        }
    };
    let path = format!("/parley-wake/{secret}");
    // "::" binds IPv6 and IPv4. Some hosts, Vers computers among them, deliver requests over IPv6 only.
    let listener = std::net::TcpListener::bind(("::", port))
        .or_else(|_| std::net::TcpListener::bind(("0.0.0.0", port)))
        .map_err(|e| user(format!("cannot listen on port {port}: {e}")))?;

    let address = format!("{}{}{path}", base.origin(), base.path.trim_end_matches('/'));
    for (origin, entry) in &servers {
        api::post_json(origin, Some(s(entry, "token")), "/api/wake", json!({ "url": address }))?;
        println!(
            "{origin} now wakes {} at this machine when mail arrives and no session is listening.",
            s(entry, "address")
        );
    }
    println!("Listening on port {port}. On a wake this runs, in {}: {command}", path_str(&cwd()));
    println!("The address holds a secret; anyone who has it can start that command. `parley wake off` stops the calls.");
    let _ = std::io::stdout().flush();

    let running = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let running = running.clone();
        let command = command.clone();
        let path = path.clone();
        std::thread::spawn(move || serve_wake(stream, &path, &command, &running));
    }
    Ok(())
}

/// Answers one HTTP request on the wake listener.
fn serve_wake(mut stream: std::net::TcpStream, expected: &str, command: &str, running: &std::sync::atomic::AtomicBool) {
    use std::sync::atomic::Ordering;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let Some((method, target)) = read_request(&mut stream) else {
        return;
    };
    let path = target.split('?').next().unwrap_or("");
    let reply = |stream: &mut std::net::TcpStream, status: &str, kind: &str, body: &str| {
        let _ = write!(
            stream,
            "HTTP/1.1 {status}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
    };
    if method != "POST" || !same_secret(path.as_bytes(), expected.as_bytes()) {
        reply(&mut stream, "404 Not Found", "text/plain;charset=utf-8", "not found\n");
        return;
    }
    if running.swap(true, Ordering::SeqCst) {
        reply(
            &mut stream,
            "202 Accepted",
            "application/json",
            r#"{"started":false,"reason":"a run is already going"}"#,
        );
        return;
    }
    println!("{} woken; running: {command}", crate::util::iso_now());
    let _ = std::io::stdout().flush();
    let child = std::process::Command::new("sh")
        .arg("-c")
        .arg(command)
        .stdin(std::process::Stdio::null())
        // Tells this client's own hooks they are inside a woken, headless run: see hook wait.
        .env("PARLEY_WOKEN", "1")
        .spawn();
    reply(&mut stream, "202 Accepted", "application/json", r#"{"started":true}"#);
    drop(stream);
    match child {
        Ok(mut child) => {
            let code = child
                .wait()
                .ok()
                .and_then(|s| s.code())
                .map_or("null".to_string(), |c| c.to_string());
            println!("{} run finished with exit code {code}", crate::util::iso_now());
        }
        Err(err) => println!("{} could not start the command: {err}", crate::util::iso_now()),
    }
    let _ = std::io::stdout().flush();
    running.store(false, Ordering::SeqCst);
}

/// Reads one request's line and headers, and drains its body.
fn read_request(stream: &mut std::net::TcpStream) -> Option<(String, String)> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 16 * 1024 || stream.read(&mut byte).ok()? == 0 {
            return None;
        }
        head.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&head).into_owned();
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split_whitespace();
    let method = first.next()?.to_string();
    let target = first.next()?.to_string();
    let length = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let _ = std::io::copy(&mut stream.take(length.min(1024 * 1024)), &mut std::io::sink());
    Some((method, target))
}

#[allow(dead_code)]
fn unused(_: Error) {}
