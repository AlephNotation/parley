// A prototype of the Parley client's hot path, to measure what a native client would cost:
// reading the config, one ordinary call (`who`) and the long-poll a waiting session holds open.
use serde_json::Value;
use std::{env, fs, path::PathBuf, time::Duration};

fn config() -> Result<Value, String> {
    let home = env::var("PARLEY_HOME").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(env::var("HOME").unwrap_or_default()).join(".parley")
    });
    let text = fs::read_to_string(home.join("config.json")).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn get(agent: &ureq::Agent, url: &str, token: &str) -> Result<Value, String> {
    let response = agent
        .get(url)
        .set("authorization", &format!("Bearer {token}"))
        .set("user-agent", "parley-lean/0")
        .call()
        .map_err(|e| e.to_string())?;
    response.into_json().map_err(|e| e.to_string())
}

fn run() -> Result<(), String> {
    let command = env::args().nth(1).unwrap_or_default();
    if command == "--version" {
        println!("0.0.0-lean");
        return Ok(());
    }
    let cfg = config()?;
    let servers = cfg["servers"].as_object().ok_or("no servers in config")?;
    let wait = command == "wait";
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(if wait { 80 } else { 30 }))
        .build();
    for (server, entry) in servers {
        let token = entry["token"].as_str().ok_or("no token")?;
        match command.as_str() {
            "who" => {
                let data = get(&agent, &format!("{server}/api/threads"), token)?;
                for thread in data["threads"].as_array().into_iter().flatten() {
                    println!("{}", thread["title"].as_str().unwrap_or("?"));
                    for p in thread["participants"].as_array().into_iter().flatten() {
                        println!("  {} [{}]", p["name"].as_str().unwrap_or("?"), p["state"].as_str().unwrap_or("?"));
                    }
                }
            }
            "wait" => {
                let data = get(&agent, &format!("{server}/api/inbox?wait=50"), token)?;
                println!("unread: {} timed_out: {}", data["unread_count"], data["timed_out"]);
            }
            _ => return Err("usage: parley-lean --version | who | wait".into()),
        }
    }
    Ok(())
}

fn main() {
    if let Err(message) = run() {
        eprintln!("parley-lean: {message}");
        std::process::exit(1);
    }
}
