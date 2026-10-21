// DigUp's Settings window, its tabs after the Mac app's (Sources/DigUpApp/SettingsWindow.swift). General: opening at
// login, centering the search panel where the desktop places windows itself (it costs memory, so it's a choice), where
// the shortcut lives, and updates. Folders: how indexing goes (with Pause), each folder searched and how far along it is, the
// folders and file types skipped, and the set hours. Code: code search's folders (added in setup's folder list for code),
// the editor its results open in, turning it off. Storage: the model, the index, privacy.
"use strict";

const tauri = window.__TAURI__;
const invoke = (command, args) => tauri.core.invoke(command, args);
const ask = (request) => invoke("ask", { request });
const isWindows = /Win/.test(navigator.platform);
const $ = (id) => document.getElementById(id);

const notes = {
  gnome: "O DigUp o adicionou aos atalhos de teclado do GNOME. Para mudá-lo: Configurações → Teclado → Ver e " +
    "Personalizar Atalhos → Atalhos Personalizados.",
  kde: "O DigUp o adicionou aos atalhos do KDE. Para mudá-lo: Configurações do Sistema → Atalhos → DigUp.",
  by_hand: "Este ambiente de desktop não deixa os aplicativos definirem os próprios atalhos. Para abrir o painel com um, " +
    "crie um atalho nas configurações de teclado dele que execute:",
};

let info = {};
let summaries = null;        // what's indexed under each folder (search-service's summaries)
let removing = null;         // the folder whose removal is being confirmed
let codeSummaries = null;    // what's indexed under each code folder
let removingCode = null;     // the code folder whose removal is being confirmed

// MARK: Tabs

function showTab(name) {
  for (const button of document.querySelectorAll("#tabs button")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === name));
  }
  for (const tab of document.querySelectorAll(".tab")) tab.hidden = tab.id !== name;
  if (name === "folders") loadSummaries();
  if (name === "code") loadCodeSummaries();
}

for (const button of document.querySelectorAll("#tabs button")) button.onclick = () => showTab(button.dataset.tab);

// MARK: General

function renderGeneral() {
  $("login-option").hidden = !info.canOpenAtLogin;
  $("login").checked = info.openAtLogin;
  $("tray-click-option").hidden = !info.canChooseTrayClick;
  for (const choice of document.querySelectorAll('input[name="tray-click"]')) choice.checked = choice.value === info.trayClick;
  $("center-option").hidden = !info.canCenter;
  $("center").checked = info.centered;
  $("processor").checked = info.processorOnly;
  $("keys").replaceChildren(...info.hotkey.split("+").filter(Boolean).map((key) => element("span", "key", shortcutKeyLabel(key))));
  const note = notes[info.shortcut.method];
  $("shortcut-note").hidden = !note;
  $("shortcut-note").textContent = note || "";
  $("shortcut-command").hidden = info.shortcut.method !== "by_hand";
  $("shortcut-command").textContent = info.shortcut.command;
  $("change-shortcut").hidden = info.shortcut.method !== "grab" || recording;
  $("recording").hidden = !recording;
  renderUpdates();
}

/// Updates: the daily check, and this version or the one waiting (updates.rs).
function renderUpdates() {
  $("update-checks").checked = info.updateChecks;
  $("update-info").textContent = "Uma vez por dia o DigUp pergunta ao GitHub qual é a versão mais nova; nada sobre os seus arquivos é enviado. "
    + (info.installsUpdates ? "As atualizações se instalam com um clique."
      : "Uma nova versão é baixada da página de lançamentos e instalada do mesmo jeito que esta foi.");
  const update = info.state && info.state.update;
  const version = $("update-version");
  version.classList.toggle("available", Boolean(update));
  version.textContent = !update ? `DigUp ${info.version}`
    : update.state === "downloading" ? `Baixando o DigUp ${update.version}…` + (update.percent != null ? ` ${update.percent}%` : "")
    : update.state === "installing" ? `Instalando o DigUp ${update.version}…` : `O DigUp ${update.version} está disponível`;
}

$("licenses").onclick = () => invoke("open_licenses").catch(fail);

$("update-version").onclick = () => {
  if (info.state && info.state.update) invoke("offer_update").catch(fail);
};
$("check-now").onclick = async () => {
  $("problem").hidden = true;
  $("check-now").disabled = true;
  try {
    await invoke("check_for_updates");
  } catch (error) {
    fail(error);
  }
  $("check-now").disabled = false;
};

/// A switch: the shell does it, or the box goes back and says why.
function wire(box, command) {
  box.addEventListener("change", async () => {
    $("problem").hidden = true;
    try {
      await invoke(command, { on: box.checked });
    } catch (error) {
      box.checked = !box.checked;
      fail(error);
    }
  });
}

wire($("login"), "set_open_at_login");
wire($("center"), "set_center_panel");
wire($("processor"), "set_processor_only");
wire($("update-checks"), "set_update_checks");
for (const choice of document.querySelectorAll('input[name="tray-click"]')) {
  choice.addEventListener("change", () => {
    $("problem").hidden = true;
    invoke("set_tray_click", { click: choice.value }).then(() => { info.trayClick = choice.value; }).catch(fail);
  });
}

// MARK: The shortcut (where DigUp grabs it itself: Windows, X11; shortcut.js)

let recording = false;

$("change-shortcut").onclick = () => {
  recording = true;
  $("problem").hidden = true;
  renderGeneral();
  recordShortcut((text) => { $("recording").textContent = text; }, (shown, problem) => {
    recording = false;
    if (shown) info.hotkey = shown;
    if (problem) fail(problem);
    renderGeneral();
  });
};

// MARK: Folders

/// How indexing goes: the status line, a bar while something's under way, the counts, and Pause or Resume.
function renderStatus() {
  const state = info.state || {};
  $("status-line").textContent = state.line || "";
  $("status-bar").hidden = state.progress == null;
  $("status-fill").style.width = `${Math.round(100 * (state.progress || 0))}%`;
  const parts = [`${(state.searchable || 0).toLocaleString("pt-BR")} de ${(state.files || 0).toLocaleString("pt-BR")} arquivos disponíveis na busca`];
  if (state.pending) parts.push(`${state.pending.toLocaleString("pt-BR")} esperando`);
  if (state.unfinished) parts.push(`${state.unfinished.toLocaleString("pt-BR")} ${state.unfinished === 1 ? "arquivo longo" : "arquivos longos"} para terminar`);
  $("status-detail").textContent = parts.join(" · ");
  $("pause").hidden = !info.folders?.length;
  $("pause").textContent = state.paused ? "Retomar" : "Pausar";
}

$("pause").onclick = () => invoke("pause_indexing", { paused: !(info.state || {}).paused }).catch(fail);

async function loadSummaries() {
  try {
    summaries = (await ask({ op: "summaries" })).roots || [];
  } catch {
    summaries = summaries || [];
  }
  renderFolders();
}

function renderFolders() {
  const rows = $("folder-rows");
  rows.replaceChildren();
  if (!info.folders?.length) rows.append(element("div", "empty", "Nenhuma pasta ainda. Adicione as que o DigUp deve buscar."));
  for (const folder of info.folders || []) {
    const summary = (summaries || []).find((item) => samePath(item.path, folder)) || null;
    rows.append(folderRow(folder, summary));
    if (removing && samePath(removing, folder)) rows.append(confirmRemoval(folder, summary));
  }
  const skipped = $("skipped-rows");
  skipped.replaceChildren();
  if (!info.skipped?.length) {
    skipped.append(element("div", "empty", "Nenhuma. Projetos de código, pacotes de aplicativos e caches já são ignorados de qualquer forma."));
  }
  for (const folder of info.skipped || []) {
    const row = element("div", "row");
    const text = element("div", "text");
    text.append(element("div", "path", shown(folder)));
    row.append(text, removeButton("Voltar a buscar nesta pasta", () => {
      setSkipped(info.skipped.filter((path) => path !== folder));
    }));
    skipped.append(row);
  }
}

/// The fields: set from the settings when the window opens or they change, never while you're editing them.
function renderFields() {
  $("types").value = (info.skipTypes || []).join(", ");
  const hours = info.indexHours || { on: false, start: 60, end: 420 };
  $("hours").checked = hours.on;
  $("times").hidden = !hours.on;
  $("hours-start").value = clock(hours.start);
  $("hours-end").value = clock(hours.end);
}

/// A folder searched (with `code`, a code folder): its name, where it is, what's in it, how much of it is indexed, and
/// Remove.
function folderRow(folder, summary, code = false) {
  const row = element("div", "row");
  const text = element("div", "text");
  const name = element("div", "name", nameOf(folder));
  if (summary?.missing || summary?.unreadable) name.append(element("span", "flag", summary.missing ? "Não conectada" : "Sem acesso"));
  text.append(name, element("div", "path", shown(folder)));
  if (summary && Object.keys(summary.kinds || {}).length) text.append(element("div", "counts", countsText(summary.kinds)));
  const side = element("div", "side");
  if (summary) {
    side.append(element("div", "indexed", summary.missing || summary.unreadable ? "Guardada para quando ela voltar"
      : `${summary.indexed.toLocaleString("pt-BR")} de ${summary.files.toLocaleString("pt-BR")} indexados`));
    const states = [
      summary.pending ? `${summary.pending.toLocaleString("pt-BR")} esperando` : null,
      summary.unfinished ? `${summary.unfinished.toLocaleString("pt-BR")} ${summary.unfinished === 1 ? "arquivo longo" : "arquivos longos"} para terminar` : null,
      summary.skipped ? `${summary.skipped.toLocaleString("pt-BR")} ignorados` : null,
      summary.failed ? `${summary.failed.toLocaleString("pt-BR")} não puderam ser lidos` : null,
    ].filter(Boolean).join(" · ");
    if (states) side.append(element("div", "states", states));
  }
  row.append(text, side, removeButton(code ? "Deixar de buscar o código nesta pasta" : "Deixar de buscar nesta pasta", () => {
    if (code) {
      removingCode = folder;
      renderCode();
    } else {
      removing = folder;
      renderFolders();
    }
  }));
  return row;
}

/// "Stop searching “Pictures”?", in place, as the Mac app asks.
function confirmRemoval(folder, summary, code = false) {
  const box = element("div", "confirm");
  const leaves = !summary ? "Os arquivos dela saem"
    : summary.files === 1 ? "O arquivo dela sai" : `Os ${summary.files.toLocaleString("pt-BR")} arquivos dela saem`;
  const last = code && (info.code?.folders || []).length === 1;
  box.append(element("p", "", code
    ? `Deixar de buscar o código em “${nameOf(folder)}”? ${leaves} do índice de código.${last ? " Isso desativa a busca de código." : ""}`
    : `Deixar de buscar em “${nameOf(folder)}”? ${leaves} do índice. Se você adicioná-la de novo depois, eles serão indexados outra vez.`));
  const actions = element("div", "actions");
  const cancel = element("button", "", "Cancelar");
  cancel.onclick = () => {
    removing = removingCode = null;
    renderFolders();
    renderCode();
  };
  const remove = element("button", "danger", "Remover");
  remove.onclick = async () => {
    removing = removingCode = null;
    try {
      await invoke(code ? "remove_code_folder" : "remove_folder", { folder });
    } catch (error) {
      fail(error);
    }
    await refresh();
  };
  actions.append(cancel, remove);
  box.append(actions);
  return box;
}

function removeButton(title, action) {
  const button = element("button", "remove", "−");
  button.title = title;
  button.setAttribute("aria-label", title);
  button.onclick = action;
  return button;
}

async function setSkipped(skipped) {
  try {
    await invoke("set_skipped", { skipped });
  } catch (error) {
    fail(error);
  }
  await refresh();
}

$("add-folders").onclick = () => invoke("choose_folders").catch(fail);
$("skip-folder").onclick = async () => {
  const picked = await invoke("pick_folders");
  if (picked.length) setSkipped([...(info.skipped || []), ...picked.filter((path) => !info.skipped.includes(path))]);
};

// File types: applied on Return, and when the field is left.
async function applyTypes() {
  try {
    info.skipTypes = await invoke("set_skip_types", { types: $("types").value });
    $("types").value = info.skipTypes.join(", ");
  } catch (error) {
    fail(error);
  }
}
$("types").addEventListener("keydown", (event) => { if (event.key === "Enter") applyTypes(); });
$("types").addEventListener("blur", applyTypes);

async function applyHours() {
  const on = $("hours").checked;
  const hours = { on, start: minutes($("hours-start").value, 60), end: minutes($("hours-end").value, 420) };
  $("times").hidden = !on;
  try {
    await invoke("set_index_hours", hours);
    info.indexHours = hours;
  } catch (error) {
    fail(error);
  }
}
$("hours").addEventListener("change", applyHours);
$("hours-start").addEventListener("change", applyHours);
$("hours-end").addEventListener("change", applyHours);

// MARK: Code

async function loadCodeSummaries() {
  if (!(info.code?.folders || []).length) {
    codeSummaries = [];
  } else {
    try {
      codeSummaries = (await ask({ op: "summaries", code: true })).roots || [];
    } catch {
      codeSummaries = codeSummaries || [];
    }
  }
  renderCode();
}

function renderCode() {
  const code = info.code || { folders: [], editors: [], editor: "default" };
  const on = code.folders.length > 0;
  // How far the code index is, over all code folders.
  const total = { files: 0, indexed: 0, pending: 0 };
  for (const summary of codeSummaries || []) {
    for (const name of Object.keys(total)) total[name] += summary[name] || 0;
  }
  $("code-status").hidden = !on || codeSummaries == null;
  $("code-status-line").textContent = total.pending
    ? `Lendo o código: ${total.indexed.toLocaleString("pt-BR")} de ${total.files.toLocaleString("pt-BR")} arquivos`
    : `${total.indexed.toLocaleString("pt-BR")} ${total.indexed === 1 ? "arquivo de código disponível" : "arquivos de código disponíveis"} na busca`;
  const size = info.storage?.codeBytes;
  $("code-status-detail").textContent = size ? `O índice de código ocupa ${bytes(size)}` : "";

  const rows = $("code-rows");
  rows.replaceChildren();
  if (!on) rows.append(element("div", "empty", "A busca de código está desativada. Escolha as pastas que guardam o seu código para ativá-la."));
  for (const folder of code.folders) {
    const summary = (codeSummaries || []).find((item) => samePath(item.path, folder)) || null;
    rows.append(folderRow(folder, summary, true));
    if (removingCode && samePath(removingCode, folder)) rows.append(confirmRemoval(folder, summary, true));
  }
  $("add-code").textContent = on ? "Adicionar pastas…" : "Escolher pastas de código…";

  const select = $("code-editor");
  const options = [...code.editors, { id: "default", name: "O aplicativo padrão do arquivo" }];
  select.replaceChildren(...options.map((editor) => {
    const option = element("option", "", editor.name);
    option.value = editor.id;
    return option;
  }));
  select.value = code.editor;
  $("code-off").hidden = !on || !$("code-off-confirm").hidden;
}

$("add-code").onclick = () => invoke("choose_code_folders").catch(fail);
$("code-editor").addEventListener("change", async () => {
  try {
    await invoke("set_code_editor", { editor: $("code-editor").value });
    info.code.editor = $("code-editor").value;
  } catch (error) {
    fail(error);
  }
});
$("code-off").onclick = () => {
  const size = info.storage?.codeBytes;
  $("code-off-text").textContent = "Desativar a busca de código? O índice dela" + (size ? ` (${bytes(size)})` : "")
    + " será apagado, e ativá-la de novo lê o código outra vez.";
  $("code-off-confirm").hidden = false;
  $("code-off").hidden = true;
};
$("code-off-cancel").onclick = () => {
  $("code-off-confirm").hidden = true;
  renderCode();
};
$("code-off-go").onclick = async () => {
  $("code-off-confirm").hidden = true;
  try {
    await invoke("turn_off_code");
  } catch (error) {
    fail(error);
  }
  await refresh();
};

// MARK: Storage

function renderStorage() {
  const storage = info.storage || {}, model = (info.state || {}).model || {};
  const states = { ready: "Baixado", checking: "Verificando…", waiting: "Esperando a rede", failed: "O download parou" };
  $("model-status").textContent = model.state === "downloading"
    ? `Baixando · ${model.total ? Math.floor((100 * model.bytes) / model.total) : 0}%` : states[model.state] || "";
  pathButton($("model-path"), storage.models);
  $("index-size").textContent = bytes(storage.indexBytes || 0) + (storage.codeBytes ? ` (código ${bytes(storage.codeBytes)})` : "");
  pathButton($("index-path"), storage.index);
  $("version").textContent = `DigUp ${info.version || ""} · EmbeddingGemma 2, do Google (Apache 2.0), executado pelo llama.cpp (MIT).`;
  $("licenses").hidden = !info.licenses;
}

/// A folder's path; a click shows it in the file manager.
function pathButton(button, path) {
  button.replaceChildren();
  if (!path) return;
  const inner = document.createElement("bdi");
  inner.textContent = shown(path);
  button.append(inner);
  button.title = isWindows ? "Mostrar no Explorador de Arquivos" : "Mostrar no gerenciador de arquivos";
  button.onclick = () => invoke("reveal", { path }).catch(fail);
}

// MARK: Words

function countsText(kinds) {
  const part = (count, one, many) => (count > 0 ? `${count.toLocaleString("pt-BR")} ${count === 1 ? one : many}` : null);
  return [
    part((kinds.image || 0) + (kinds.screenshot || 0), "imagem", "imagens"),
    part(kinds.pdf, "PDF", "PDFs"),
    part(kinds.doc, "documento", "documentos"),
    part(kinds.audio, "gravação", "gravações"),
    part(kinds.video, "vídeo", "vídeos"),
    part(kinds.code, "arquivo de código", "arquivos de código"),
  ].filter(Boolean).join(" · ");
}

/// Sizes the way file managers count them: "62 KB", "2.1 MB".
function bytes(count) {
  if (count < 1000) return `${count} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = count / 1000, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1).replace(".", ",")} ${units[unit]}`;
}

function clock(minute) {
  return `${String(Math.trunc(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function minutes(text, fallback) {
  const match = /^(\d{1,2}):(\d{2})/.exec(text || "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
}

function nameOf(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function shown(path) {
  return isWindows ? path.replaceAll("/", "\\") : path;
}

function samePath(a, b) {
  const plain = (path) => (path || "").replaceAll("\\", "/").replace(/\/$/, "");
  return isWindows ? plain(a).toLowerCase() === plain(b).toLowerCase() : plain(a) === plain(b);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function fail(error) {
  $("problem").textContent = String(error);
  $("problem").hidden = false;
}

// MARK: Start

async function refresh() {
  info = await invoke("settings_info");
  renderGeneral();
  renderStatus();
  renderFolders();
  renderFields();
  renderStorage();
  renderCode();
  if (!$("folders").hidden) loadSummaries();
  if (!$("code").hidden) loadCodeSummaries();
}

// Back from the code folders window (or anything else that changed the settings): shown as they are now.
window.addEventListener("focus", () => { refresh().catch(() => {}); });

// Indexing as it goes, and what's indexed under each folder at most every two seconds.
let summariesTimer = null;
tauri.event.listen("state", ({ payload }) => {
  const before = info.state || {};
  info.state = payload;
  renderStatus();
  renderStorage();
  renderUpdates();
  // The code index's progress isn't in the state: its folders are asked again while the tab is up.
  const counts = payload.searchable !== before.searchable || payload.pending !== before.pending;
  const load = !$("folders").hidden && counts ? loadSummaries : !$("code").hidden ? loadCodeSummaries : null;
  if (load && !summariesTimer) {
    summariesTimer = setTimeout(() => { summariesTimer = null; load(); }, 2000);
  }
});

async function start() {
  await refresh();
  // Debug runs (--debug-settings): the page is up.
  if (info.debug) {
    invoke("debug_report", { report: { settings: true, hotkey: info.hotkey, openAtLogin: info.openAtLogin,
                                       canOpenAtLogin: info.canOpenAtLogin, folders: info.folders } }).catch(() => {});
  }
  const asked = new URLSearchParams(location.search).get("tab");   // dev snapshots: ?tab=folders
  showTab(asked || "general");
}

start();
