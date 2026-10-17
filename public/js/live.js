// 实况照片（Apple Live Photo / Google 动态照片）：照片上叠一层短视频
// 列表和正文里鼠标悬停播放；查看器里打开时静音播放一次，点「实况」按钮带声音重播，手机长按画面播放

export const isLive = (a) => !!a && a.kind === "image" && (a.live_offset != null || !!a.live_path);
export const liveUrl = (id) => `/files/${id}/live`;

export const LIVE_ICON = `<svg viewBox="0 0 24 24" class="live-ico"><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="5.8"/><circle cx="12" cy="12" r="9.2" stroke-dasharray="1.6 2.2"/></svg>`;
export const liveTag = () => `<span class="live-tag">${LIVE_ICON}实况</span>`;

/**
 * 在 box 里播放一次实况视频（没有就建一个 video.live-v 铺满 box），播完淡回照片
 * @returns {() => void} 停止
 */
export function playLive(box, id, { muted = true } = {}) {
  let v = box.querySelector("video.live-v");
  if (!v) {
    v = document.createElement("video");
    v.className = "live-v";
    v.playsInline = true;
    v.preload = "auto";
    v.src = liveUrl(id);
    box.append(v);
  }
  const stop = () => {
    v.classList.remove("on");
    box.classList.remove("live-playing");
    v.pause();
  };
  v.muted = muted;
  v.onended = stop;
  v.onplaying = () => v.classList.add("on");
  box.classList.add("live-playing");
  try { v.currentTime = 0; } catch { /* 元数据还没加载 */ }
  v.play().catch(stop);
  return stop;
}

// 列表与正文：鼠标移到带 data-live 的元素上播放，移出停止（触摸设备在查看器里长按）
let hovering = null;
document.addEventListener("pointerover", (e) => {
  if (e.pointerType !== "mouse") return;
  const box = e.target.closest?.("[data-live]");
  if (!box || hovering?.box === box) return;
  hovering?.stop();
  hovering = { box, stop: playLive(box, box.dataset.live) };
});
document.addEventListener("pointerout", (e) => {
  if (!hovering || e.pointerType !== "mouse") return;
  if (e.relatedTarget && hovering.box.contains(e.relatedTarget)) return;
  hovering.stop();
  hovering = null;
});
