// The progress card: where DigUp is on the way from a fresh start to searchable, in Portuguese, for the window's home.
// The shell's snapshot (status.rs) says the phase and since when, the counts, the file being read and how long the
// index helper has been quiet; the search service's `summaries` say what's read of each folder. The first sync of a big
// folder says nothing until it's done, so the card counts the wait instead of leaving a bare "Starting…".
"use strict";

const DigUpProgress = (() => {
  const STEPS = ["Modelo", "Velocidade", "Pastas", "Leitura", "Pronto"];
  /// The step each phase is on (the ones before it are done, the ones after still to come).
  const STEP_OF = { model: 0, measuring: 1, starting: 2, scanning: 2, indexing: 3, finishing: 3, paused: 3, held: 3, idle: 4 };
  const TITLES = {
    model: "Baixando o modelo de busca",
    measuring: "Medindo a velocidade deste computador",
    starting: "Preparando a leitura das pastas",
    scanning: "Lendo as pastas",
    indexing: "Lendo os arquivos",
    finishing: "Terminando os PDFs e documentos longos",
    paused: "Indexação pausada",
    held: "Indexação fora do horário",
    idle: "Arquivos esperando leitura",
    failed: "A indexação parou",
  };
  const KINDS = [["screenshot", "captura de tela", "capturas de tela"], ["image", "imagem", "imagens"],
                 ["pdf", "PDF", "PDFs"], ["doc", "documento", "documentos"], ["audio", "áudio", "áudios"],
                 ["video", "vídeo", "vídeos"]];
  /// How long the first walk of the folders is left alone before the card says what can be done about it.
  const LONG_SCAN = 300, LONG_FILE = 120;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const number = (value) => (value || 0).toLocaleString("pt-BR");
  const nameOf = (path) => String(path).split(/[\\/]/).filter(Boolean).pop() || String(path);

  /// "45 s", "13 min 02 s", "1 h 05 min"
  function duration(seconds) {
    const total = Math.max(0, Math.round(seconds));
    if (total < 60) return `${total} s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes} min ${String(total % 60).padStart(2, "0")} s`;
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
  }

  /// "cerca de 12 min": a guess, said like one.
  function roughly(seconds) {
    if (seconds < 90) return "cerca de 1 min";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `cerca de ${minutes} min`;
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    return rest ? `cerca de ${hours} h ${rest} min` : `cerca de ${hours} h`;
  }

  /// Is there anything to tell: not when everything is read, whether DigUp is idle, paused or held (nothing is waiting).
  function needed(app) {
    const phase = app && app.phase;
    if (!phase || phase === "nofolders") return false;
    return !["idle", "paused", "held"].includes(phase) || (app.pending || 0) > 0;
  }

  /// `options.openSettings`: what the "Ajustes" button does. Returns the card's node, `update(app, roots)` to redraw it
  /// with the shell's snapshot and the folders' summaries, and `stop()` to end its clock.
  function create(options = {}) {
    const node = el("section", "pg");
    let app = {}, roots = [], clock = null;

    function steps(phase) {
      const list = el("ol", "pg-steps");
      // Idle with files waiting is still the reading step; with none waiting the card isn't shown at all.
      const current = phase === "idle" ? 3 : STEP_OF[phase] ?? 3;
      STEPS.forEach((label, index) => {
        const item = el("li", index < current ? "done" : index === current ? "active" : "todo");
        item.append(el("span", "dot"), el("span", "label", label));
        if (index === current) item.setAttribute("aria-current", "step");
        list.append(item);
      });
      return list;
    }

    function bar(fraction) {
      const track = el("div", "pg-bar");
      const fill = el("div", "fill");
      if (fraction == null) track.classList.add("unknown");
      else fill.style.width = `${Math.round(100 * Math.max(0, Math.min(1, fraction)))}%`;
      track.append(fill);
      track.setAttribute("role", "progressbar");
      if (fraction != null) track.setAttribute("aria-valuenow", String(Math.round(100 * fraction)));
      return track;
    }

    function body(phase, since) {
      const box = el("div", "pg-body");
      const read = app.searchable || 0, waiting = app.pending || 0;
      switch (phase) {
        case "model":
          box.append(bar(app.progress), el("p", "pg-line", app.line || ""));
          break;
        case "measuring":
          box.append(bar(null), el("p", "pg-line", "Isso leva alguns segundos e só acontece uma vez."));
          if (app.estimating > 0) {
            box.append(el("p", "pg-note", "Esperando a contagem das pastas terminar, para não distorcer a medição (até 2 minutos)."));
          }
          break;
        case "starting":
          box.append(bar(null), el("p", "pg-line", "Iniciando o leitor de arquivos…"));
          break;
        case "scanning":
          box.append(bar(null), el("p", "pg-line", `Percorrendo as pastas há ${duration(since)}…`),
                     el("p", "pg-note", "A cada partida o DigUp confere os arquivos das pastas antes de ler o próximo. Na "
                       + "primeira vez, em pastas grandes, isso leva vários minutos, e nada aparece aqui até o fim dessa etapa."));
          break;
        case "indexing":
        case "finishing": {
          const total = read + waiting;
          const fraction = phase === "finishing" ? app.progress : total > 0 ? read / total : null;
          box.append(bar(fraction));
          const line = el("p", "pg-line");
          line.append(el("strong", "", phase === "finishing" ? `${Math.round(100 * (app.progress || 0))}%`
                                                              : `${number(read)} de ${number(total)}`),
                      phase === "finishing" ? " das páginas dos arquivos longos" : " arquivos lidos");
          box.append(line);
          const facts = [];
          if (waiting > 0 && phase === "indexing") facts.push(`${number(waiting)} esperando`);
          if (app.etaSecs != null && phase === "indexing") facts.push(`${roughly(app.etaSecs)} para esta etapa`);
          if (facts.length) box.append(el("p", "pg-sub", facts.join(" · ")));
          if (app.current) {
            const now = el("p", "pg-now");
            now.append(el("span", "tag", "Lendo agora"), el("span", "file", nameOf(app.current.path)));
            now.title = app.current.path;
            box.append(now);
          }
          break;
        }
        case "paused":
          box.append(el("p", "pg-line", `Pausada com ${number(waiting)} arquivos esperando.`),
                     el("p", "pg-note", "Retome pelo menu do ícone na bandeja ou em Ajustes → Pastas."));
          break;
        case "held":
          box.append(el("p", "pg-line", `${number(waiting)} arquivos esperando${app.heldUntil ? ` · a leitura volta às ${app.heldUntil}` : ""}.`));
          break;
        case "idle":
          box.append(el("p", "pg-line", `${number(waiting)} arquivos esperando para serem lidos.`),
                     el("p", "pg-note", "O DigUp os lê quando o computador estiver tranquilo."));
          break;
        default:
          box.append(el("p", "pg-line", app.line || "Algo impediu a leitura dos arquivos."));
      }
      return box;
    }

    /// The folders, each with how much of it is read: the part of the question "what's read and what isn't".
    function folders(phase) {
      if (!roots.length || phase === "model" || phase === "measuring" || phase === "failed") return null;
      const list = el("ul", "pg-folders");
      for (const root of roots) {
        const row = el("li", "pg-folder");
        const unknown = !root.files && (phase === "scanning" || phase === "starting");
        const readable = (root.files || 0) - (root.skipped || 0) - (root.failed || 0);
        const head = el("div", "head");
        head.append(el("span", "name", nameOf(root.path)));
        let text;
        if (root.missing) text = "Não conectada";
        else if (root.unreadable) text = "Sem acesso";
        else if (unknown) text = "na fila";
        else text = `${number(root.indexed)} de ${number(readable > 0 ? readable : root.files)} lidos`;
        head.append(el("span", "count", text));
        row.append(head);
        row.title = root.path;
        if (!unknown && !root.missing && !root.unreadable && readable > 0) {
          const done = el("div", "pg-mini");
          const fill = el("div", "fill");
          fill.style.width = `${Math.round(100 * Math.min(1, (root.indexed || 0) / readable))}%`;
          done.append(fill);
          row.append(done);
        }
        list.append(row);
      }
      return list;
    }

    /// What the folders hold, by kind ("4.200 imagens · 310 PDFs").
    function kinds(phase) {
      if (phase === "model" || phase === "measuring" || phase === "scanning" || phase === "starting") return null;
      const totals = {};
      for (const root of roots) for (const [kind, count] of Object.entries(root.kinds || {})) totals[kind] = (totals[kind] || 0) + count;
      const parts = KINDS.filter(([kind]) => totals[kind] > 0)
        .map(([kind, one, many]) => `${number(totals[kind])} ${totals[kind] === 1 ? one : many}`);
      return parts.length ? el("p", "pg-kinds", `Encontrados: ${parts.join(" · ")}`) : null;
    }

    /// When the helper has been quiet so long that the person may wonder, and what can be done.
    function warning(phase) {
      const quiet = app.quietSecs;
      if (quiet == null) return null;
      let text = null, settings = false;
      if (phase === "scanning" && quiet >= LONG_SCAN) {
        text = `A leitura das pastas já dura ${duration(quiet)}. Pastas com muitos arquivos pequenos (repositórios, `
          + "node_modules, caches) demoram mais. Para acelerar, deixe de fora as pastas pesadas.";
        settings = true;
      } else if ((phase === "indexing" || phase === "finishing") && quiet >= LONG_FILE) {
        text = `O DigUp está há ${duration(quiet)} no mesmo arquivo${app.current ? ` (${nameOf(app.current.path)})` : ""}. `
          + "Vídeos longos e PDFs enormes levam tempo; se passar do limite, ele interrompe e pula o arquivo.";
      }
      if (!text) return null;
      const box = el("div", "pg-warn");
      box.append(el("p", "", text));
      if (settings && options.openSettings) {
        const button = el("button", "", "Escolher as pastas");
        button.onclick = () => options.openSettings();
        box.append(button);
      }
      return box;
    }

    function draw() {
      const phase = app.phase || "starting";
      const since = Math.max(0, (Date.now() - (app.phaseSince || Date.now())) / 1000);
      const head = el("div", "pg-head");
      head.append(el("h3", "pg-title", TITLES[phase] || TITLES.scanning));
      if (phase !== "failed" && phase !== "paused" && phase !== "held") head.append(el("span", "pg-time", `há ${duration(since)}`));
      const parts = [head];
      if (phase !== "failed") parts.push(steps(phase));
      parts.push(body(phase, since));
      for (const part of [warning(phase), folders(phase), kinds(phase)]) if (part) parts.push(part);
      node.replaceChildren(...parts);
    }

    function tick() {
      // The clock only runs while the card is on the page; its text is all that changes between snapshots. A button
      // under the pointer isn't replaced: a press that straddled a redraw would be lost.
      if (!node.isConnected) return stop();
      if (node.querySelector("button:hover")) return;
      draw();
    }

    function stop() {
      clearInterval(clock);
      clock = null;
    }

    return {
      node,
      update(snapshot, summaries) {
        app = snapshot || {};
        if (summaries) roots = summaries;
        draw();
        if (!clock) clock = setInterval(tick, 1000);
      },
      stop,
    };
  }

  return { create, needed, duration, roughly };
})();
