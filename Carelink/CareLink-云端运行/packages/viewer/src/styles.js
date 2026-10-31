export const VIEWER_STYLES = `
.unseen-viewer{position:relative;width:100%;height:100%;min-height:240px;overflow:hidden;background:#170e12;color:#fff8f5;font-family:Inter,PingFang SC,Noto Sans CJK SC,Microsoft YaHei,ui-sans-serif,system-ui,sans-serif;contain:layout paint style}
.unseen-viewer *{box-sizing:border-box}
.unseen-viewer__stage,.unseen-viewer__canvas,.unseen-viewer__fallback{position:absolute;inset:0;width:100%;height:100%}
.unseen-viewer__canvas{display:block;touch-action:none;cursor:grab;outline:none}
.unseen-viewer__canvas:active{cursor:grabbing}
.unseen-viewer__canvas:focus-visible,.unseen-viewer button:focus-visible{outline:2px solid #d7c6ff;outline-offset:3px}
.unseen-viewer__fallback{object-fit:contain;background:#170e12}
.unseen-viewer__hud{position:absolute;inset:0;z-index:2;pointer-events:none;padding:12px;display:flex;flex-direction:column;justify-content:space-between;gap:12px}
.unseen-viewer__top,.unseen-viewer__bottom{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;pointer-events:none}
.unseen-viewer__controls{display:flex;flex-wrap:wrap;gap:8px;pointer-events:auto}
.unseen-viewer button{min-width:44px;min-height:44px;padding:8px 12px;border:1px solid #8c6877;border-radius:10px;background:#24171de8;color:#fff8f5;font:inherit;font-weight:600;cursor:pointer}
.unseen-viewer button:hover{background:#302027}
.unseen-viewer button[hidden]{display:none}
.unseen-viewer__status{max-width:min(72ch,calc(100% - 8px));padding:8px 12px;border:1px solid #8c6877;border-radius:999px;background:#24171de8;color:#fff8f5;font-size:14px;line-height:20px;pointer-events:none}
.unseen-viewer__directions{display:grid;grid-template-columns:44px 44px 44px;grid-template-rows:44px 44px;gap:4px;pointer-events:auto}
.unseen-viewer__directions button{padding:0}
.unseen-viewer__directions [data-direction=up]{grid-column:2}.unseen-viewer__directions [data-direction=left]{grid-column:1;grid-row:2}.unseen-viewer__directions [data-direction=down]{grid-column:2;grid-row:2}.unseen-viewer__directions [data-direction=right]{grid-column:3;grid-row:2}
.unseen-viewer[data-render-mode=flat_fallback] .unseen-viewer__directions{display:none}
.unseen-viewer__translation-controls{display:none;grid-template-columns:repeat(4,44px);gap:4px;pointer-events:auto}
.unseen-viewer__translation-controls button{padding:0}
.unseen-viewer[data-depth-ready=true] .unseen-viewer__translation-controls{display:grid}
.unseen-viewer__joystick{display:none;position:absolute;left:max(16px,env(safe-area-inset-left));bottom:max(72px,env(safe-area-inset-bottom));width:112px;height:112px;border:2px solid #8c6877;border-radius:50%;background:#24171db8;pointer-events:auto;touch-action:none}
.unseen-viewer__joystick::after{content:"";position:absolute;left:35px;top:35px;width:38px;height:38px;border:2px solid #d7c6ff;border-radius:50%;transform:translate(var(--stick-x,0px),var(--stick-y,0px));background:#302027}
.unseen-viewer[data-depth-ready=true] .unseen-viewer__joystick{display:none}
.unseen-viewer__sr{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
@media (hover:none) and (pointer:coarse){.unseen-viewer[data-depth-ready=true] .unseen-viewer__joystick{display:block}.unseen-viewer__directions{display:none}}
@media (prefers-reduced-motion:reduce){.unseen-viewer *{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important}}
@media (max-width:520px){.unseen-viewer__hud{padding:8px}.unseen-viewer__status{font-size:12px;line-height:16px;max-width:100%}.unseen-viewer button{padding:6px 9px}.unseen-viewer__bottom{align-items:flex-end}}
`;
