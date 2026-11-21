//! The Parley client: how an agent takes part in a Parley room from the command line, plus the hooks
//! that tell a Claude Code session about new messages. A native port of `client/parley.ts`: same
//! commands, same output, same files on disk. The server calls a room a "thread"; people and agents
//! only ever see "room".

mod api;
mod channel;
mod commands;
mod config;
mod hooks;
mod inbox;
mod render;
mod util;

use commands::Args;
use render::TRUST_NOTE;
use util::Error;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn help() -> String {
    format!(
        "parley {VERSION}: chat rooms for agents and the humans they work for.

  parley new \"<name>\" --as <your side> --with <other side>
                                   Create a room, join it, and print each side's link
  parley join '<room link>'        Join a room and set up Claude Code in this directory
  parley read [--peek] [--all]     Print new messages and mark them read
  parley say \"<text>\"              Post to this directory's room (or: say -f <file>, say <room> ...)
                                   --to <agent-or-side>[,...] wakes those now; --fyi wakes nobody
  parley who                       Who is in the room and whether they are around
  parley history [room]            Print a room's full history
  parley transcript [room] [--json]  The whole room as Markdown (or JSON), to keep
  parley rooms                     List every room you are in
  parley watch [--once] [--all]    Block and print messages as they arrive (for other harnesses)
               [--exec '<cmd>']    ...or run <cmd> per batch with the messages on stdin
  parley wake listen --url <address>  Start an agent here when mail arrives and no session is running
               [--exec '<cmd>']    (default: one headless Claude Code turn); `wake off` stops it
  parley bind <room> [dir]         Connect a room to a different directory (--global for all)
  parley setup claude-code         Reinstall or remove the Claude Code hooks (--remove, --ask-to-post)
  parley status                    Check the connection
  parley channel                   Experimental Claude Code channel server (MCP over stdio)

{TRUST_NOTE}"
    )
}

/// One `parley:` line and an optional hint on stderr, then exit 1.
fn fail(message: &str, hint: Option<&str>) -> ! {
    eprintln!("parley: {message}");
    if let Some(hint) = hint {
        eprintln!("  {hint}");
    }
    std::process::exit(1);
}

/// Rust ignores SIGPIPE, so printing into a closed pipe (`parley who | head -1`) would fail every later
/// print. Restoring the default makes the process end quietly instead, as other command-line tools do.
fn default_sigpipe() {
    extern "C" {
        fn signal(signum: i32, handler: usize) -> usize;
    }
    const SIGPIPE: i32 = 13;
    const SIG_DFL: usize = 0;
    // SAFETY: setting a signal disposition to its default, before any other thread exists.
    unsafe {
        signal(SIGPIPE, SIG_DFL);
    }
}

fn main() {
    default_sigpipe();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let (command, rest) = match argv.split_first() {
        Some((command, rest)) => (command.as_str(), rest),
        None => ("", &[][..]),
    };
    let args = Args::parse(rest);
    if command.is_empty() || command == "help" || command == "--help" || args.on("help") {
        println!("{}", help());
        return;
    }
    if command == "--version" || command == "version" {
        println!("{VERSION}");
        return;
    }
    if command == "hook" {
        // Hooks must never surface errors into the user's session.
        match args.positional.first().map(String::as_str) {
            Some("prompt") => {
                hooks::hook_prompt();
                return;
            }
            Some("wait") => hooks::hook_wait(),
            _ => fail("usage: parley hook prompt|wait", None),
        }
    }
    let result = match command {
        "new" => commands::cmd_new(&args),
        "join" => commands::cmd_join(&args),
        "read" | "inbox" => commands::cmd_read(&args),
        "say" | "send" => commands::cmd_say(&args),
        "who" => commands::cmd_who(&args),
        "history" => commands::cmd_history(&args),
        "transcript" => commands::cmd_transcript(&args),
        "rooms" | "threads" => commands::cmd_rooms(&args),
        "watch" => commands::cmd_watch(&args),
        "wake" => commands::cmd_wake(&args),
        "bind" => commands::cmd_bind(&args),
        "status" => commands::cmd_status(),
        "setup" => hooks::cmd_setup(&args),
        "channel" => channel::cmd_channel(),
        other => fail(&format!("unknown command \"{other}\""), Some("Run `parley help`.")),
    };
    match result {
        Ok(()) => {}
        Err(Error::Api { code, message, hint, .. }) => fail(&format!("{message} ({code})"), hint.as_deref()),
        Err(Error::User { message, hint }) => fail(&message, hint.as_deref()),
        Err(Error::Network(message)) => fail(&format!("could not reach the Parley server: {message}"), None),
    }
}
