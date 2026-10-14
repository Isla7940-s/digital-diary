// 统计：记录热力图（按字数）、AI 调用热力图、媒体构成与月度趋势
import { $, $$, api, ICON, fmtNum, fmtSize, fmtHours, dayKey, showTip, hideTip } from "../lib.js";

const KINDS = [
  { k: "image", label: "照片", color: "var(--k-image)" },
  { k: "video", label: "视频", color: "var(--k-video)" },
  { k: "audio", label: "录音", color: "var(--k-audio)" },
  { k: "other", label: "其他", color: "var(--k-other)" },
];
const RAMPS = {
  amber: ["var(--heat-0)", "var(--amber-1)", "var(--amber-2)", "var(--amber-3)", "var(--amber-4)"],
  blue: ["var(--heat-0)", "var(--blue-1)", "var(--blue-2)", "var(--blue-3)", "var(--blue-4)"],
};

/** 量化为 0-4 级：小数值直接用计数，大数值按最大值四等分 */
function leveler(values) {
  const max = Math.max(0, ...values);
  if (max <= 4) return (v) => Math.min(v, 4);
  const t = [0.25, 0.5, 0.75].map((f) => Math.ceil(max * f));
  return (v) => (v <= 0 ? 0 : v <= t[0] ? 1 : v <= t[1] ? 2 : v <= t[2] ? 3 : 4);
}

/** GitHub 式日历热力图：最近 53 周，周一开头 */
function heatmap(el, byDay, { ramp, unit, label }) {
  const draw = () => {
    const width = el.clientWidth || 700;
    const cell = Math.max(10, Math.min(17, Math.floor((width - 28) / 53) - 3));
    const end = new Date(); end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - 52 * 7 - ((end.getDay() + 6) % 7));
    const days = [];
    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(dayKey(d));
    const lv = leveler(days.map((d) => byDay.get(d) || 0));
    const colors = RAMPS[ramp];
    const todayKey = dayKey(end);
    let months = "", lastM = -1;
    for (let w = 0; w * 7 < days.length; w++) {
      const m = Number(days[w * 7].slice(5, 7));
      months += `<span>${m !== lastM && Number(days[w * 7].slice(8)) <= 7 ? `${m}月` : ""}</span>`;
      if (Number(days[w * 7].slice(8)) <= 7) lastM = m;
    }
    el.innerHTML = `<div class="heat-wrap"><div class="heat" style="--cell:${cell}px">
      <div class="months">${months}</div>
      <div class="wdays"><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span><span></span></div>
      <div class="cells">${days.map((d) => {
        const v = byDay.get(d) || 0;
        return `<i class="c ${d === todayKey ? "today" : ""}" data-d="${d}" data-v="${v}" style="background:${colors[lv(v)]}"></i>`;
      }).join("")}</div></div></div>`;
    const wrap = $(".heat-wrap", el);
    wrap.scrollLeft = wrap.scrollWidth;
    $(".cells", el).addEventListener("mousemove", (e) => {
      const c = e.target.closest(".c");
      if (!c) return hideTip();
      const r = c.getBoundingClientRect();
      const [y, m, d] = c.dataset.d.split("-");
      showTip(r.left + r.width / 2, r.top, `<b>${c.dataset.v === "0" ? "无" : `${fmtNum(+c.dataset.v)} ${unit}`}</b> ${label}<br>${y}年${+m}月${+d}日`);
    });
    $(".cells", el).addEventListener("mouseleave", hideTip);
  };
  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(el);
  return () => ro.disconnect();
}

function legend(ramp) {
  return `<span class="legend">少${RAMPS[ramp].map((c) => `<i style="background:${c}"></i>`).join("")}多</span>`;
}

export async function render({ app }) {
  const s = await api("/stats");
  const kind = (k) => s.kinds.find((x) => x.kind === k) || { count: 0, bytes: 0, seconds: 0 };
  const other = { count: kind("text").count + kind("file").count, bytes: kind("text").bytes + kind("file").bytes, seconds: 0 };
  const kv = { image: kind("image"), video: kind("video"), audio: kind("audio"), other };
  const totalBytes = s.kinds.reduce((t, k) => t + k.bytes, 0) + s.pages.bytes;
  const year = s.entryDays.reduce((t, d) => t + d.count, 0);
  const activeDays = s.entryDays.length;
  const mcpYear = s.mcpDays.reduce((t, d) => t + d.count, 0);
  const mcpErr = s.mcpDays.reduce((t, d) => t + d.errors, 0);

  app.innerHTML = `
    <div class="page-head"><div><h1>统计</h1><div class="sub">${s.first_entry ? `自 ${s.first_entry} 起` : "从第一篇日记开始"} · 截至 ${s.today}</div></div></div>

    <div class="kpis">
      <div class="card kpi"><span class="kl">${ICON.entries}日记</span><span class="kv">${fmtNum(s.counts.entries)}<small>篇</small></span><span class="ks">过去一年 ${activeDays} 天有记录</span></div>
      <div class="card kpi"><span class="kl">${ICON.fire}连续记录</span><span class="kv">${s.streak}<small>天</small></span><span class="ks">${s.streak ? "保持住！" : "今天写一篇吧"}</span></div>
      <div class="card kpi"><span class="kl">${ICON.image}照片</span><span class="kv">${fmtNum(kv.image.count)}</span><span class="ks">${fmtSize(kv.image.bytes)}</span></div>
      <div class="card kpi"><span class="kl">${ICON.video}视频</span><span class="kv">${fmtNum(kv.video.count)}</span><span class="ks">${kv.video.seconds ? `共 ${fmtHours(kv.video.seconds)}` : fmtSize(kv.video.bytes)}</span></div>
      <div class="card kpi"><span class="kl">${ICON.audio}录音</span><span class="kv">${fmtNum(kv.audio.count)}</span><span class="ks">${kv.audio.seconds ? `共 ${fmtHours(kv.audio.seconds)}` : fmtSize(kv.audio.bytes)}</span></div>
      <div class="card kpi"><span class="kl">${ICON.page}纸质原稿</span><span class="kv">${fmtNum(s.pages.count)}<small>页</small></span><span class="ks">${fmtNum(s.counts.ungrouped)} 项待归组</span></div>
      <div class="card kpi"><span class="kl">${ICON.hdd}占用空间</span><span class="kv" style="font-size:22px">${fmtSize(totalBytes)}</span><span class="ks">原件，未压缩</span></div>
    </div>

    <section class="card panel">
      <div class="panel-head"><h2>记录热力图</h2><span class="grow"></span>
        <div class="seg" id="heatSeg"><button class="on" data-v="entries">日记</button><button data-v="media">影像</button></div></div>
      <div id="heatA"></div>
      <div class="heat-foot"><span id="heatSum"></span>${legend("amber")}</div>
    </section>

    <section class="card panel">
      <div class="panel-head"><h2>AI 调用</h2><span class="sub">通过 MCP 连接器的每一次工具调用</span></div>
      <div id="heatB"></div>
      <div class="heat-foot"><span>过去一年 <b style="color:var(--ink)">${fmtNum(mcpYear)}</b> 次调用 · ${s.mcpDays.length} 天活跃${mcpYear ? ` · 成功率 ${(((mcpYear - mcpErr) / mcpYear) * 100).toFixed(1)}%` : ""}</span>${legend("blue")}</div>
    </section>

    <div class="two-col">
      <section class="card panel">
        <div class="panel-head"><h2>媒体构成</h2><span class="sub">按数量</span></div>
        <div class="stack" id="stack"></div>
        <table class="kind-table"><tbody id="kindRows"></tbody></table>
      </section>
      <section class="card panel">
        <div class="panel-head"><h2>近 12 个月新增影像</h2><span class="grow"></span>
          <span class="legend">${KINDS.map((k) => `<span class="sw"><i style="background:${k.color}"></i>${k.label}</span>`).join("")}</span></div>
        <div class="cols" id="months"></div><div class="cols-x" id="monthsX"></div>
      </section>
    </div>`;

  // ---------- 热力图 ----------
  const entryMap = new Map(s.entryDays.map((d) => [d.day, d.chars]));
  const yearChars = s.entryDays.reduce((t, d) => t + d.chars, 0);
  const mediaMap = new Map(s.mediaDays.map((d) => [d.day, d.count]));
  let offA = heatmap($("#heatA"), entryMap, { ramp: "amber", unit: "字", label: "日记" });
  const sumA = (mode) => {
    $("#heatSum").innerHTML = mode === "entries"
      ? `过去一年写了 <b style="color:var(--ink)">${fmtNum(yearChars)}</b> 字（${fmtNum(year)} 篇），${activeDays} 天有记录`
      : `过去一年拍摄/录制了 <b style="color:var(--ink)">${fmtNum(s.mediaDays.reduce((t, d) => t + d.count, 0))}</b> 项影像`;
  };
  sumA("entries");
  $("#heatSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$("#heatSeg button").forEach((x) => x.classList.toggle("on", x === b));
    offA();
    offA = b.dataset.v === "entries"
      ? heatmap($("#heatA"), entryMap, { ramp: "amber", unit: "字", label: "日记" })
      : heatmap($("#heatA"), mediaMap, { ramp: "amber", unit: "项", label: "影像" });
    sumA(b.dataset.v);
  });
  const offB = heatmap($("#heatB"), new Map(s.mcpDays.map((d) => [d.day, d.count])), { ramp: "blue", unit: "次", label: "AI 调用" });

  // ---------- 媒体构成 ----------
  const totalCount = KINDS.reduce((t, k) => t + kv[k.k].count, 0);
  $("#stack").innerHTML = totalCount ? KINDS.filter((k) => kv[k.k].count).map((k) =>
    `<i style="flex:${kv[k.k].count};background:${k.color}" data-k="${k.label}" data-v="${kv[k.k].count}"></i>`).join("") : `<i style="flex:1;background:var(--heat-0)"></i>`;
  $("#kindRows").innerHTML = KINDS.map((k) => `<tr><td><i style="background:${k.color}"></i>${k.label}</td>
    <td class="r">${fmtNum(kv[k.k].count)} 项</td><td class="r">${totalCount ? ((kv[k.k].count / totalCount) * 100).toFixed(0) : 0}%</td>
    <td class="r">${fmtSize(kv[k.k].bytes)}</td><td class="r">${kv[k.k].seconds ? fmtHours(kv[k.k].seconds) : "—"}</td></tr>`).join("");

  // ---------- 月度堆叠柱 ----------
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const byMonth = months.map((m) => {
    const row = { image: 0, video: 0, audio: 0, other: 0 };
    for (const x of s.months.filter((r) => r.month === m)) row[["image", "video", "audio"].includes(x.kind) ? x.kind : "other"] += x.count;
    return row;
  });
  const maxM = Math.max(1, ...byMonth.map((r) => r.image + r.video + r.audio + r.other));
  $("#months").innerHTML = byMonth.map((r, i) => `<div class="col" data-i="${i}">${KINDS.filter((k) => r[k.k]).map((k) =>
    `<i style="height:calc(${(r[k.k] / maxM) * 100}% - 2px);background:${k.color}"></i>`).join("")}</div>`).join("");
  $("#monthsX").innerHTML = months.map((m, i) => `<span>${i % 2 === (months.length - 1) % 2 ? `${+m.slice(5)}月` : ""}</span>`).join("");

  // ---------- 悬浮提示 ----------
  const tipFor = (e) => {
    if (e.target.closest(".heat")) return;
    const col = e.target.closest("#months .col");
    if (col) {
      const r = byMonth[col.dataset.i], m = months[col.dataset.i];
      const rect = col.getBoundingClientRect();
      return showTip(rect.left + rect.width / 2, rect.top, `<b>${m.slice(0, 4)}年${+m.slice(5)}月</b>` + KINDS.map((k) =>
        `<div class="row"><i style="background:${k.color}"></i>${k.label}<span style="margin-left:auto;padding-left:12px"><b>${r[k.k]}</b></span></div>`).join(""));
    }
    const st = e.target.closest("#stack i[data-k]");
    if (st) { const rect = st.getBoundingClientRect(); return showTip(e.clientX, rect.top, `${st.dataset.k} <b>${fmtNum(st.dataset.v)}</b> 项`); }
    hideTip();
  };
  const panelEls = $$(".panel", app);
  panelEls.forEach((p) => { p.addEventListener("mousemove", tipFor); p.addEventListener("mouseleave", hideTip); });

  return () => { offA(); offB(); hideTip(); };
}
