/*
 * text-edit.js — その場テキスト編集ツール（Googleスライド感覚のインライン編集）
 *
 * 動画「HTMLスライドエディター」と同じことを各講義ページ上で実現する試作版。
 *
 * 【外部では閲覧専用・自分だけ編集モード】
 *   編集UIが出るのは次のときだけ:
 *     - localhost / 127.0.0.1 で開いている
 *     - もしくは URL の末尾に #edit を付けて開いた  (例: 01.html#edit)
 *   GitHub Pages で普通に開いた受講者には編集ボタンは出ません。
 *
 * 【保存】
 *   File System Access API を使い、初回に手元の実ファイル(01.html等)を選択 →
 *   以後は「保存」で同じファイルへ直接上書きします（サーバ不要）。
 *   対応: Chrome / Edge。Firefox / Safari は API 非対応のため案内のみ表示。
 *
 * 【保存される中身】
 *   編集で注入したUI・contenteditable属性などは取り除き、元の素のHTMLだけを
 *   書き戻します。編集ツール自体の <script> タグは残ります。
 */
(() => {
  "use strict";

  // ── 編集モードを出すかどうかの判定 ───────────────────────────────
  const host = location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "";
  const hashEdit = /(^|[#&])edit\b/.test(location.hash);
  if (!isLocal && !hashEdit) return; // 通常の閲覧者には何も出さない

  if (window.__textEditLoaded) return;
  window.__textEditLoaded = true;

  // <head> から読み込まれると body 未生成のことがあるので準備後に初期化
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  function init() {

  const fsaSupported = typeof window.showOpenFilePicker === "function";

  // 編集対象にする要素（テキストを持つブロック）
  const EDITABLE_SELECTOR =
    "h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,figcaption,span,strong,em,b,i,a,dt,dd";

  let editing = false;        // 編集モード on/off
  let fileHandle = null;      // 保存先ファイルのハンドル
  let dirty = false;          // 未保存の変更があるか

  // ── スタイル注入 ─────────────────────────────────────────────────
  const style = document.createElement("style");
  style.setAttribute("data-editor-ui", "");
  style.textContent = `
    .te-bar{position:fixed;top:14px;right:14px;z-index:2147483000;display:flex;gap:8px;
      align-items:center;font-family:'Noto Sans JP',system-ui,sans-serif;font-size:13px;
      background:rgba(25,13,52,0.92);backdrop-filter:blur(8px);border:1px solid rgba(255,79,168,0.45);
      border-radius:12px;padding:8px 10px;box-shadow:0 8px 28px rgba(0,0,0,0.45);color:#F8EFFF}
    .te-bar button{font:inherit;cursor:pointer;border:1px solid rgba(248,239,255,0.22);
      background:rgba(248,239,255,0.06);color:#F8EFFF;border-radius:8px;padding:6px 12px;transition:.15s}
    .te-bar button:hover{background:rgba(255,79,168,0.22);border-color:rgba(255,79,168,0.6)}
    .te-bar button.te-primary{background:#FF4FA8;color:#22103d;border-color:#FF4FA8;font-weight:700}
    .te-bar button.te-primary:hover{filter:brightness(1.08)}
    .te-bar button:disabled{opacity:.4;cursor:default}
    .te-dot{width:8px;height:8px;border-radius:50%;background:#5AE9FF;box-shadow:0 0 8px #5AE9FF}
    .te-dot.te-dirty{background:#FFB14F;box-shadow:0 0 8px #FFB14F}
    body.te-on [contenteditable]{outline:2px dashed rgba(90,233,255,0.7);outline-offset:3px;border-radius:4px}
    body.te-on .te-hot{outline:1px dashed rgba(255,79,168,0.5);outline-offset:2px;cursor:text}
    .te-float{position:fixed;z-index:2147483000;display:none;gap:4px;align-items:center;
      background:rgba(25,13,52,0.96);border:1px solid rgba(255,79,168,0.5);border-radius:10px;
      padding:5px 7px;box-shadow:0 6px 20px rgba(0,0,0,0.5)}
    .te-float.te-show{display:flex}
    .te-float button{font-family:'Noto Sans JP',sans-serif;cursor:pointer;border:1px solid rgba(248,239,255,0.2);
      background:rgba(248,239,255,0.06);color:#F8EFFF;border-radius:6px;width:30px;height:30px;font-size:14px}
    .te-float button:hover{background:rgba(255,79,168,0.25)}
    .te-float .te-swatch{width:24px;height:24px;border-radius:6px;border:1px solid rgba(248,239,255,0.3);cursor:pointer;padding:0}
    .te-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483000;
      background:rgba(25,13,52,0.96);color:#F8EFFF;border:1px solid rgba(90,233,255,0.5);
      border-radius:10px;padding:10px 18px;font-family:'Noto Sans JP',sans-serif;font-size:13px;
      box-shadow:0 8px 24px rgba(0,0,0,0.5);opacity:0;transition:opacity .25s;pointer-events:none}
    .te-toast.te-show{opacity:1}
  `;
  document.head.appendChild(style);

  // ── 上部バー ─────────────────────────────────────────────────────
  const bar = document.createElement("div");
  bar.className = "te-bar";
  bar.setAttribute("data-editor-ui", "");
  bar.innerHTML = `
    <span class="te-dot" id="te-dot" title="状態"></span>
    <button id="te-toggle" class="te-primary">📝 編集</button>
    <button id="te-save" disabled>💾 保存</button>
  `;
  document.body.appendChild(bar);

  // ── 選択テキスト用の浮動ツールバー ───────────────────────────────
  const COLORS = ["#FF4FA8", "#5AE9FF", "#FFB14F", "#9D7BFF", "#7CF2A0", "#F8EFFF", "#190d34"];
  const float = document.createElement("div");
  float.className = "te-float";
  float.setAttribute("data-editor-ui", "");
  float.innerHTML =
    `<button data-cmd="bold" title="太字"><b>B</b></button>` +
    COLORS.map((c) => `<button class="te-swatch" data-color="${c}" style="background:${c}" title="文字色 ${c}"></button>`).join("");
  document.body.appendChild(float);

  const dotEl = bar.querySelector("#te-dot");
  const toggleBtn = bar.querySelector("#te-toggle");
  const saveBtn = bar.querySelector("#te-save");

  function toast(msg, ok = true) {
    const t = document.createElement("div");
    t.className = "te-toast";
    t.setAttribute("data-editor-ui", "");
    t.style.borderColor = ok ? "rgba(90,233,255,0.5)" : "rgba(255,120,120,0.6)";
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("te-show"));
    setTimeout(() => {
      t.classList.remove("te-show");
      setTimeout(() => t.remove(), 300);
    }, 2200);
  }

  function setDirty(v) {
    dirty = v;
    dotEl.classList.toggle("te-dirty", v);
    saveBtn.disabled = !v;
  }

  // ── 編集モード切替 ───────────────────────────────────────────────
  function enterEdit() {
    editing = true;
    document.body.classList.add("te-on");
    toggleBtn.textContent = "✓ 完了";
    toggleBtn.classList.remove("te-primary");
    bindHotElements();
    toast("ダブルクリックで文字を直接編集できます");
  }

  function exitEdit() {
    // 編集中の要素を確定
    document.querySelectorAll('[contenteditable="true"]').forEach((el) => {
      el.removeAttribute("contenteditable");
      el.removeAttribute("spellcheck");
    });
    editing = false;
    document.body.classList.remove("te-on");
    toggleBtn.textContent = "📝 編集";
    toggleBtn.classList.add("te-primary");
    hideFloat();
  }

  toggleBtn.addEventListener("click", () => (editing ? exitEdit() : enterEdit()));

  // 編集可能な要素にホバー枠を付ける（ダブルクリックでその場編集）
  function bindHotElements() {
    document.querySelectorAll(EDITABLE_SELECTOR).forEach((el) => {
      if (el.closest("[data-editor-ui]")) return;
      if (el.dataset.teBound) return;
      // 子に編集対象を含む入れ子は、最も内側だけをホット扱いにする
      if (el.querySelector(EDITABLE_SELECTOR)) return;
      el.dataset.teBound = "1";
      el.classList.add("te-hot");
    });
  }

  // ダブルクリックでその要素を編集可能化
  document.addEventListener("dblclick", (e) => {
    if (!editing) return;
    const el = e.target.closest(".te-hot");
    if (!el || el.closest("[data-editor-ui]")) return;
    if (el.getAttribute("contenteditable") === "true") return;
    el.setAttribute("contenteditable", "true");
    el.setAttribute("spellcheck", "false");
    el.focus();
    el.addEventListener("input", () => setDirty(true), { once: false });
    // クリック位置にカーソルを置く
  });

  // 編集要素からフォーカスが外れたら contenteditable を解除
  document.addEventListener(
    "focusout",
    (e) => {
      const el = e.target;
      if (el && el.getAttribute && el.getAttribute("contenteditable") === "true") {
        setTimeout(() => {
          if (document.activeElement !== el) {
            el.removeAttribute("contenteditable");
            el.removeAttribute("spellcheck");
          }
        }, 50);
      }
    },
    true
  );

  // ── 選択テキスト → 浮動ツールバー ────────────────────────────────
  function hideFloat() {
    float.classList.remove("te-show");
  }
  function updateFloat() {
    if (!editing) return hideFloat();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hideFloat();
    const anchor = sel.anchorNode;
    const host = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
    if (!host || !host.closest('[contenteditable="true"]')) return hideFloat();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) return hideFloat();
    float.classList.add("te-show");
    const fw = float.offsetWidth, fh = float.offsetHeight;
    let left = rect.left + rect.width / 2 - fw / 2;
    let top = rect.top - fh - 8;
    left = Math.max(8, Math.min(left, window.innerWidth - fw - 8));
    if (top < 8) top = rect.bottom + 8;
    float.style.left = left + "px";
    float.style.top = top + "px";
  }
  document.addEventListener("selectionchange", updateFloat);
  window.addEventListener("scroll", () => updateFloat(), true);

  // 浮動ツールバーの操作（execCommand: 選択範囲にインライン適用）
  float.addEventListener("mousedown", (e) => e.preventDefault()); // 選択を保持
  float.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.cmd === "bold") {
      document.execCommand("bold");
    } else if (btn.dataset.color) {
      document.execCommand("styleWithCSS", false, true);
      document.execCommand("foreColor", false, btn.dataset.color);
    }
    setDirty(true);
  });

  // ── 保存（File System Access で実ファイルへ上書き）───────────────
  async function pickFile() {
    const opts = {
      types: [{ description: "HTML", accept: { "text/html": [".html", ".htm"] } }],
      excludeAcceptAllOption: false,
      multiple: false,
    };
    const [handle] = await window.showOpenFilePicker(opts);
    return handle;
  }

  // 保存用に現在のDOMをクリーンなHTML文字列へ
  function serializeClean() {
    const root = document.documentElement.cloneNode(true);
    // 注入したUIを削除
    root.querySelectorAll("[data-editor-ui]").forEach((n) => n.remove());
    // 編集の痕跡を除去
    root.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));
    root.querySelectorAll("[spellcheck]").forEach((n) => n.removeAttribute("spellcheck"));
    root.querySelectorAll(".te-hot").forEach((n) => n.classList.remove("te-hot"));
    root.querySelectorAll("[data-te-bound]").forEach((n) => n.removeAttribute("data-te-bound"));
    root.querySelectorAll("body.te-on, body").forEach((n) => n.classList.remove("te-on"));
    // class="" の空属性を掃除
    root.querySelectorAll('[class=""]').forEach((n) => n.removeAttribute("class"));
    return "<!DOCTYPE html>\n" + root.outerHTML + "\n";
  }

  async function save() {
    if (!fsaSupported) {
      toast("このブラウザは直接保存に未対応です（Chrome/Edgeをご利用ください）", false);
      return;
    }
    try {
      if (!fileHandle) {
        toast("保存先のファイル（このページのhtml）を選択してください");
        fileHandle = await pickFile();
      }
      const perm = await fileHandle.requestPermission({ mode: "readwrite" });
      if (perm !== "granted") {
        toast("書き込み許可が得られませんでした", false);
        return;
      }
      const writable = await fileHandle.createWritable();
      await writable.write(serializeClean());
      await writable.close();
      setDirty(false);
      toast("保存しました ✓ （git push で公開版に反映できます）");
    } catch (err) {
      if (err && err.name === "AbortError") return; // ユーザーがキャンセル
      console.error(err);
      toast("保存に失敗しました: " + (err && err.message ? err.message : err), false);
    }
  }
  saveBtn.addEventListener("click", save);

  // Ctrl/Cmd+S で保存
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      if (editing || dirty) {
        e.preventDefault();
        save();
      }
    }
  });

  // 未保存のまま離脱しようとしたら警告
  window.addEventListener("beforeunload", (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  if (!fsaSupported) {
    saveBtn.title = "直接保存はChrome/Edgeのみ対応です";
  }

  } // end init
})();
