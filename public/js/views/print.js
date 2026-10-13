// 打印二维码标签（二维码只包含编号）
import { $, $$, api, esc, ICON, today } from "../lib.js";

export async function render({ app, query }) {
  const selected = new Set((query.get("ids") || "").split(",").filter(Boolean));
  const t = today();
  const from = `${t.slice(0, 8)}01`;
  app.innerHTML = `
    <div class="page-head no-print"><div><h1>打印标签</h1><div class="sub">二维码只包含编号本身，剪下后贴在纸质日记对应页上</div></div></div>
    <div class="print-grid">
      <section class="card print-controls no-print">
        <div class="row2">
          <label class="field">从<input type="date" id="pFrom" value="${from}"></label>
          <label class="field">到<input type="date" id="pTo" value="${t}"></label>
        </div>
        <div class="checks" id="pick"><div class="spinner"></div></div>
        <div class="row2">
          <label class="field">尺寸<select id="pSize"><option value="20">小 · 20mm</option><option value="30" selected>中 · 30mm</option><option value="40">大 · 40mm</option></select></label>
          <label class="field">每个份数<input type="number" id="pCopies" value="1" min="1" max="50"></label>
        </div>
        <button class="btn primary block" id="pPrint">${ICON.print}打印</button>
      </section>
      <div class="paper-sheet" id="sheet"></div>
    </div>`;

  const renderSheet = () => {
    const size = Number($("#pSize").value);
    const copies = Math.min(Math.max(parseInt($("#pCopies").value) || 1, 1), 50);
    const sheet = $("#sheet");
    sheet.style.setProperty("--lw", `${size}mm`);
    sheet.style.setProperty("--lf", `${size <= 20 ? 7 : size <= 30 ? 9 : 11}pt`);
    sheet.innerHTML = selected.size
      ? [...selected].flatMap((id) => Array(copies).fill(`<div class="qlabel"><img src="/api/qr/${encodeURIComponent(id)}.svg" alt=""><div class="lid">${esc(id)}</div></div>`)).join("")
      : `<p class="muted" style="padding:20px">在左侧勾选日记以生成标签</p>`;
  };
  const loadList = async () => {
    const r = await api(`/entries?from=${$("#pFrom").value}&to=${$("#pTo").value}&limit=500`);
    const known = new Set(r.items.map((e) => e.id));
    const items = [...[...selected].filter((id) => !known.has(id)).map((id) => ({ id, title: "" })), ...r.items];
    $("#pick").innerHTML = items.length
      ? `<label><input type="checkbox" id="pAll"> <b>全选</b></label>` + items.map((e) =>
        `<label><input type="checkbox" value="${esc(e.id)}" ${selected.has(e.id) ? "checked" : ""}> <span class="idpill">${esc(e.id)}</span> <span class="muted">${esc(e.title || "")}</span></label>`).join("")
      : `<p class="muted" style="padding:10px;font-size:13px">这段时间没有日记</p>`;
  };
  $("#pick").addEventListener("change", (e) => {
    if (e.target.id === "pAll") $$("input[value]", $("#pick")).forEach((c) => { c.checked = e.target.checked; c.checked ? selected.add(c.value) : selected.delete(c.value); });
    else if (e.target.value) e.target.checked ? selected.add(e.target.value) : selected.delete(e.target.value);
    renderSheet();
  });
  $("#pFrom").addEventListener("change", loadList);
  $("#pTo").addEventListener("change", loadList);
  $("#pSize").addEventListener("change", renderSheet);
  $("#pCopies").addEventListener("input", renderSheet);
  $("#pPrint").addEventListener("click", () => print());
  await loadList();
  renderSheet();
}
