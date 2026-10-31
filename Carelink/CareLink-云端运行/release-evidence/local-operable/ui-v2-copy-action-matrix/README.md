# UI v2 copy/action closure

Status: **PASS** for the fixed product code commit `74adfba49cb15eba3be3db91b10545a16c76db43`, based on Stage5 candidate `4028310f02feb3e0d992c8ea56403cf4764d86c8`.

This is loopback-only, deterministic fixture evidence. The UI visibly states “本地确定性样本 / 非真实 AI / 不代表正式发布”. It is not provider, production, or release evidence.

## Closed actions

- Withdrawing a memory clears its answer, follow-up, saved draft, confirmation, consent, and downstream contribution; a recoverable empty state links back to the source photo.
- Withdrawing the Book contribution changes the available-memory count from 14 to 13, removes `page-memory-01` from the editable draft, and leaves no `photo-01` source in the rendered fixture artifact.
- “制作新版” creates local fixture version `book-version-local-03`, resets preview/frozen state, and opens the editable draft.
- BL06 “返回编辑新版” invokes the same action and creates `book-version-local-04` before returning to the editable draft.

## Browser matrix

`CHROME-DESKTOP-MOBILE.json` records 44 directly clicked visible controls across home, space, album, photo, memory BL01–BL03, and Book BL04–BL06. It includes Chrome 1440 px, mobile 390 px, 720 px as the 200% desktop equivalent, keyboard focus/recovery, PDF/HTML/receipt semantics, and 19 screenshots. Console issues, HTTP failures, external requests, and external resources are all zero.

The sample phase selectors are display-only and are not counted as product actions. Core empty/error injection remains honestly unexercised because the existing UI-v2 harness exposes no supported injection point; no product code was added to manufacture one.
