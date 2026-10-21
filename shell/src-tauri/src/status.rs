//! What DigUp is doing, in the words the tray, the window and the panel use: the index helper's events and the model's
//! download turned into one line, a progress and a caveat for results (the Mac app's AppModel and EngineStatus).

use serde_json::{json, Value};

#[derive(Clone, Debug, Default, PartialEq)]
pub enum Activity {
    /// The index helper hasn't reported yet.
    #[default]
    Starting,
    Idle,
    /// A pass over new or changed files: `done` of `total`.
    Indexing { done: u64, total: u64 },
    /// The rest of long PDFs and documents: `done` of the `total` pages and chunks this pass reads, `files` unfinished.
    Finishing { done: u64, total: u64, files: u64 },
    Failed(String),
}

#[derive(Clone, Debug, Default)]
pub struct Status {
    pub activity: Activity,
    /// Files in the index, in any state.
    pub files: u64,
    /// Done or partly read: what search finds by what's in it.
    pub searchable: u64,
    /// Waiting to be read.
    pub pending: u64,
    /// Long files with pages or chunks still to read.
    pub unfinished: u64,
    /// Chosen folders that aren't there now (an unplugged drive), and ones DigUp can't read: skipped, files kept.
    pub missing: Vec<String>,
    pub unreadable: Vec<String>,
    /// The speed check before the first index is running.
    pub measuring: bool,
    /// Indexing is paused (Pause Indexing): nothing is read until it's resumed; search goes on.
    pub paused: bool,
    /// Outside the set hours (Settings → Folders): when they begin ("01:00").
    pub held_until: Option<String>,
    /// When the index helper started and when it last said anything (ms since the epoch): the helper's first sync walks
    /// every folder and says nothing until it's done, so a long silence is shown rather than guessed at.
    pub helper_started: Option<u64>,
    pub last_event: Option<u64>,
    /// The file being read: its path and kind.
    pub current: Option<(String, String)>,
    /// The pass under way: when it began and the count it began at, for the time left.
    pass: Option<(u64, u64)>,
}

/// Milliseconds since the epoch.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64)
}

impl Status {
    /// An index-service event (`Sources/digup/IndexService.swift`); events about the code index don't count here.
    pub fn apply(&mut self, event: &Value) {
        self.apply_at(event, now_ms());
    }

    /// The index helper was asked to work: its start counts only the first time (a running helper is just told to sync
    /// again), until it exits.
    pub fn helper_started_at(&mut self, now: u64) {
        if self.helper_started.is_none() {
            self.helper_started = Some(now);
            self.last_event = None;
        }
    }

    fn apply_at(&mut self, event: &Value, now: u64) {
        if event["code"] == true {
            return;
        }
        self.last_event = Some(now);
        let count = |key: &str| event[key].as_u64().unwrap_or(0);
        if event["files"].is_u64() {
            self.files = count("files");
            self.searchable = count("searchable");
            self.pending = count("pending");
            self.unfinished = count("unfinished");
        }
        match event["event"].as_str().unwrap_or_default() {
            "sync" if count("new") > 0 => self.activity = Activity::Indexing { done: 0, total: count("new") },
            // A sync after a failure: the helper works again.
            "sync" if matches!(self.activity, Activity::Failed(_)) => self.activity = Activity::Idle,
            "file" => {
                let done = count("done");
                // A new pass starts at a count below the last one's (the sync's few files, then the backfill's).
                if !matches!(self.activity, Activity::Indexing { done: before, .. } if before <= done) || self.pass.is_none() {
                    self.pass = Some((now, done.saturating_sub(1)));
                }
                if let (Some(path), Some(kind)) = (event["path"].as_str(), event["kind"].as_str()) {
                    self.current = Some((path.to_string(), kind.to_string()));
                }
                self.activity = Activity::Indexing { done, total: count("total") };
                // The counts come with a sync; each file read since leaves "waiting".
                self.pending = self.pending.saturating_sub(1);
                if matches!(event["state"].as_str(), Some("done" | "partial")) {
                    self.searchable += 1;
                }
            }
            "rest" => {
                self.activity = Activity::Finishing { done: count("done"), total: count("total"), files: count("files") }
            }
            "idle" | "waiting" => {
                self.activity = Activity::Idle;
                self.current = None;
                self.pass = None;
            }
            "missing" => {
                let paths = |key: &str| -> Vec<String> {
                    event[key].as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect()
                };
                self.missing = paths("folders");
                self.unreadable = paths("unreadable");
            }
            "error" if event["fatal"] == true => self.activity = Activity::Failed("A indexação parou".into()),
            // The helper is gone: whatever it was doing is over.
            "exit" | "ended" => {
                if matches!(self.activity, Activity::Starting | Activity::Indexing { .. } | Activity::Finishing { .. }) {
                    self.activity = Activity::Idle;
                }
                self.helper_started = None;
                self.current = None;
                self.pass = None;
            }
            _ => {}
        }
    }

    /// One line for the tray and the window: "Indexing 42% · 120 of 306", "306 files indexed".
    pub fn line(&self, has_folders: bool, model: &Value) -> String {
        if !has_folders {
            return "Nenhuma pasta escolhida ainda".into();
        }
        if let Activity::Failed(problem) = &self.activity {
            return format!("⚠︎ {problem}");
        }
        // Nothing is read before the model is in (file names are searchable once indexing starts).
        if let Some(line) = download_line(model) {
            return line;
        }
        if self.measuring {
            return "Medindo a velocidade deste computador…".into();
        }
        match self.activity {
            // The helper's first sync walks every folder and says nothing until it's done: say that it's at it.
            Activity::Starting if self.helper_started.is_some() && !self.paused && self.held_until.is_none() => {
                "Lendo as pastas…".into()
            }
            // Held or paused, no index helper runs to say it has started: what's indexed stands.
            Activity::Starting if !self.paused && self.held_until.is_none() => "Iniciando…".into(),
            Activity::Indexing { done, total } => format!("Indexando {}% · {} de {}", percent(done, total), number(done), number(total)),
            Activity::Finishing { done, total, files } => {
                let which = if files > 0 { format!("{} {}", number(files), plural(files, "arquivo longo", "arquivos longos")) } else { "arquivos longos".into() };
                format!("Lendo o resto de {which} · {}%", percent(done, total))
            }
            _ if self.pending > 0 => {
                let waiting = format!("{} {} esperando", number(self.pending), plural(self.pending, "arquivo", "arquivos"));
                match &self.held_until {
                    _ if self.paused => format!("Pausado · {waiting}"),
                    Some(start) => format!("{waiting} · indexação a partir das {start}"),
                    None => format!("{waiting} para indexar"),
                }
            }
            _ => {
                let indexed = format!("{} {}", number(self.searchable), plural(self.searchable, "arquivo indexado", "arquivos indexados"));
                match &self.held_until {
                    _ if self.paused => format!("{indexed} · pausado"),
                    Some(start) => format!("{indexed} · indexação a partir das {start}"),
                    None => indexed,
                }
            }
        }
    }

    /// A few words beside the panel's field while results may be incomplete: "Indexing 42%", "Downloading model · 42%".
    pub fn badge(&self, model: &Value) -> Option<String> {
        if model["state"] == "downloading" {
            return Some(format!("Baixando o modelo · {}%", (fraction(model) * 100.0) as u64));
        }
        if self.paused && self.pending > 0 {
            return Some("Indexação pausada".into());
        }
        match self.activity {
            Activity::Indexing { done, total } if total > 0 => Some(format!("Indexando {}%", percent(done, total))),
            _ => None,
        }
    }

    /// Something is under way or can't start: Index Now has nothing to add.
    pub fn busy(&self, model: &Value) -> bool {
        model["state"] != "ready" || self.measuring || self.paused || self.held_until.is_some()
            || matches!(self.activity, Activity::Indexing { .. } | Activity::Finishing { .. })
    }

    /// 0…1 while something is under way (the download, then an indexing pass or the rest of long files).
    pub fn progress(&self, model: &Value) -> Option<f64> {
        if model["state"] == "downloading" {
            return Some(fraction(model));
        }
        match self.activity {
            Activity::Indexing { done, total } | Activity::Finishing { done, total, .. } if total > 0 => {
                Some(done as f64 / total as f64)
            }
            _ => None,
        }
    }

    /// Why results may be incomplete right now: the model isn't in yet, or files aren't read yet.
    pub fn caveat(&self, model: &Value) -> Option<String> {
        match model["state"].as_str() {
            Some("downloading") => {
                return Some(format!("Só por palavras até o modelo terminar de baixar ({}%)", (fraction(model) * 100.0) as u64))
            }
            Some("waiting" | "failed") => return Some("Só por palavras: o modelo não foi baixado".into()),
            _ => {}
        }
        if let Activity::Indexing { done, total } = self.activity {
            if total > 0 {
                return Some(format!("Ainda indexando ({}%): alguns arquivos ainda não entraram", percent(done, total)));
            }
        }
        (self.pending > 0).then(|| {
            format!("{} {}", number(self.pending), plural(self.pending, "arquivo ainda não foi indexado", "arquivos ainda não foram indexados"))
        })
    }

    /// Where DigUp is on the way from a fresh start to searchable, for the progress the pages draw:
    /// nofolders · model · measuring · starting · scanning · indexing · finishing · paused · held · idle · failed.
    /// "scanning" is the index helper's first sync, which walks the folders and says nothing until it's done.
    pub fn phase(&self, has_folders: bool, model: &Value) -> &'static str {
        if !has_folders {
            return "nofolders";
        }
        if matches!(self.activity, Activity::Failed(_)) {
            return "failed";
        }
        if download_line(model).is_some() {
            return "model";
        }
        if self.measuring {
            return "measuring";
        }
        if self.paused {
            return "paused";
        }
        if self.held_until.is_some() {
            return "held";
        }
        match self.activity {
            Activity::Starting if self.helper_started.is_some() => "scanning",
            Activity::Starting => "starting",
            Activity::Indexing { .. } => "indexing",
            Activity::Finishing { .. } => "finishing",
            _ => "idle",
        }
    }

    /// Seconds the index helper has been quiet while it should be at work (since it started, or its last event).
    pub fn quiet_secs(&self, now: u64) -> Option<u64> {
        let since = self.last_event.or(self.helper_started)?;
        matches!(self.activity, Activity::Starting | Activity::Indexing { .. } | Activity::Finishing { .. })
            .then(|| now.saturating_sub(since) / 1000)
    }

    /// Seconds left in the pass under way, once it has read enough to go by.
    pub fn eta_secs(&self, now: u64) -> Option<u64> {
        let (Activity::Indexing { done, total }, Some((began, first))) = (&self.activity, self.pass) else { return None };
        let (read, elapsed) = (done.saturating_sub(first), now.saturating_sub(began));
        (read >= 3 && elapsed >= 5_000 && total >= done).then(|| elapsed * (total - done) / read / 1000)
    }

    /// What the pages show: the line, the progress, the caveat, and the counts. `estimating` is the number of folder
    /// estimates running (setup's list).
    pub fn snapshot(&self, has_folders: bool, model: &Value, estimating: usize, now: u64) -> Value {
        let indexing = match self.activity {
            Activity::Indexing { done, total } => json!({"done": done, "total": total}),
            _ => Value::Null,
        };
        json!({
            "phase": self.phase(has_folders, model),
            "estimating": estimating,
            "quietSecs": self.quiet_secs(now),
            "etaSecs": self.eta_secs(now),
            "current": self.current.as_ref().map(|(path, kind)| json!({"path": path, "kind": kind})),
            "line": self.line(has_folders, model),
            "progress": self.progress(model),
            "caveat": self.caveat(model),
            "indexing": indexing,
            "files": self.files,
            "searchable": self.searchable,
            "pending": self.pending,
            "unfinished": self.unfinished,
            "measuring": self.measuring,
            "paused": self.paused,
            "heldUntil": self.held_until,
            "badge": self.badge(model),
            "busy": self.busy(model),
            "activity": match self.activity {
                Activity::Starting => "starting",
                Activity::Idle => "idle",
                Activity::Indexing { .. } => "indexing",
                Activity::Finishing { .. } => "finishing",
                Activity::Failed(_) => "failed",
            },
            "model": model,
        })
    }
}

/// While the model isn't there, how its download goes.
fn download_line(model: &Value) -> Option<String> {
    match model["state"].as_str()? {
        "downloading" => Some(format!("Baixando o modelo · {}%", (fraction(model) * 100.0) as u64)),
        "checking" => Some("Verificando o download do modelo…".into()),
        "waiting" => Some("Download do modelo: esperando a rede".into()),
        "failed" => Some("⚠︎ O download do modelo parou".into()),
        _ => None,
    }
}

fn fraction(model: &Value) -> f64 {
    let (bytes, total) = (model["bytes"].as_f64().unwrap_or(0.0), model["total"].as_f64().unwrap_or(0.0));
    if total > 0.0 { (bytes / total).clamp(0.0, 1.0) } else { 0.0 }
}

/// Rounded down, so 100% means done.
fn percent(done: u64, total: u64) -> u64 {
    if total == 0 { 0 } else { done * 100 / total }
}

fn plural(count: u64, one: &'static str, many: &'static str) -> &'static str {
    if count == 1 { one } else { many }
}

/// "1.204"
pub fn number(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            out.push('.');
        }
        out.push(digit);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines() {
        let ready = json!({"state": "ready"});
        let mut status = Status::default();
        assert_eq!(status.line(false, &ready), "Nenhuma pasta escolhida ainda");
        assert_eq!(status.line(true, &ready), "Iniciando…");
        assert_eq!(status.line(true, &json!({"state": "downloading", "bytes": 432.0, "total": 865.0})),
                   "Baixando o modelo · 49%");
        status.apply(&json!({"event": "sync", "new": 306, "files": 306, "searchable": 0, "pending": 306}));
        assert_eq!(status.line(true, &ready), "Indexando 0% · 0 de 306");
        status.apply(&json!({"event": "file", "done": 129, "total": 306}));
        assert_eq!(status.line(true, &ready), "Indexando 42% · 129 de 306");
        assert_eq!(status.progress(&ready), Some(129.0 / 306.0));
        assert_eq!(status.caveat(&ready).as_deref(), Some("Ainda indexando (42%): alguns arquivos ainda não entraram"));
        status.apply(&json!({"event": "file", "done": 1, "total": 1, "code": true}));
        assert_eq!(status.line(true, &ready), "Indexando 42% · 129 de 306");
        status.apply(&json!({"event": "rest", "done": 40, "total": 100, "files": 3}));
        assert_eq!(status.line(true, &ready), "Lendo o resto de 3 arquivos longos · 40%");
        status.apply(&json!({"event": "idle", "files": 1306, "searchable": 1306, "pending": 0, "unfinished": 0}));
        assert_eq!(status.line(true, &ready), "1.306 arquivos indexados");
        assert_eq!(status.progress(&ready), None);
        assert_eq!(status.caveat(&ready), None);
        status.apply(&json!({"event": "error", "message": "worker died", "fatal": true}));
        assert_eq!(status.line(true, &ready), "⚠︎ A indexação parou");

        let mut held = Status { held_until: Some("01:00".into()), ..Status::default() };
        held.apply(&json!({"event": "counts", "files": 70, "searchable": 66, "pending": 4, "unfinished": 0}));
        assert_eq!(held.line(true, &ready), "4 arquivos esperando · indexação a partir das 01:00");
        assert!(held.busy(&ready));
        held.held_until = None;
        held.paused = true;
        assert_eq!(held.line(true, &ready), "Pausado · 4 arquivos esperando");
    }

    #[test]
    fn phases() {
        let ready = json!({"state": "ready"});
        let mut status = Status::default();
        assert_eq!(status.phase(false, &ready), "nofolders");
        assert_eq!(status.phase(true, &json!({"state": "downloading", "bytes": 1.0, "total": 2.0})), "model");
        assert_eq!(status.phase(true, &ready), "starting");
        status.measuring = true;
        assert_eq!(status.phase(true, &ready), "measuring");
        status.measuring = false;

        // The helper's first sync walks every folder and says nothing until it's done: the silence is counted.
        status.helper_started_at(1_000);
        assert_eq!(status.phase(true, &ready), "scanning");
        assert_eq!(status.line(true, &ready), "Lendo as pastas…");
        assert_eq!(status.quiet_secs(61_000), Some(60));
        status.apply_at(&json!({"event": "sync", "new": 100, "files": 100, "searchable": 0, "pending": 100}), 70_000);
        assert_eq!(status.phase(true, &ready), "indexing");
        assert_eq!(status.quiet_secs(75_000), Some(5));

        // No time left is promised before it has read a few files and a few seconds have gone.
        let file = |done: u64, at: u64, status: &mut Status| {
            status.apply_at(&json!({"event": "file", "done": done, "total": 100, "path": "C:\\a.png", "kind": "image"}), at)
        };
        file(1, 71_000, &mut status);
        assert_eq!(status.eta_secs(72_000), None);
        for done in 2..=11 {
            file(done, 71_000 + done * 1000, &mut status);
        }
        assert_eq!(status.eta_secs(82_000), Some(89));
        assert_eq!(status.current, Some(("C:\\a.png".into(), "image".into())));

        status.paused = true;
        assert_eq!(status.phase(true, &ready), "paused");
        status.paused = false;
        status.apply_at(&json!({"event": "idle", "files": 100, "searchable": 100, "pending": 0, "unfinished": 0}), 90_000);
        assert_eq!(status.phase(true, &ready), "idle");
        assert_eq!((status.current.clone(), status.quiet_secs(99_000), status.eta_secs(99_000)), (None, None, None));
        status.apply_at(&json!({"event": "exit"}), 91_000);
        assert_eq!(status.helper_started, None);
    }

    #[test]
    fn numbers() {
        assert_eq!(number(0), "0");
        assert_eq!(number(999), "999");
        assert_eq!(number(1000), "1.000");
        assert_eq!(number(1234567), "1.234.567");
    }
}
