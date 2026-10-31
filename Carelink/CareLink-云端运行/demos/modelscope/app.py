import gradio as gr


APP_URL = "https://unseen-d3gtp0sxh53bbef61-1316841054.tcloudbaseapp.com/"

APP_HTML = f"""
<main class="unseen-shell">
  <iframe
    class="unseen-app"
    src="{APP_URL}"
    title="UNSEEN 活动共同记忆空间"
    allow="camera; clipboard-write; fullscreen; web-share"
    loading="eager"
  ></iframe>
</main>
"""

CSS = """
html, body { width: 100%; height: 100%; margin: 0 !important; overflow: hidden; }
.gradio-container {
  width: 100% !important; max-width: none !important; height: 100dvh !important;
  min-height: 0 !important; margin: 0 !important; padding: 0 !important; overflow: hidden !important;
}
.gradio-container main, .main, .wrap, .contain {
  width: 100% !important; max-width: none !important; height: 100% !important;
  min-height: 0 !important; margin: 0 !important; padding: 0 !important;
}
#unseen-root, #unseen-root > .html-container, #unseen-root .prose {
  width: 100% !important; height: 100% !important; min-height: 0 !important; padding: 0 !important;
}
.unseen-shell { position: relative; width: 100%; height: 100%; min-height: 0; background: #fff; }
.unseen-app { position: absolute; inset: 0; display: block; width: 100%; height: 100%; border: 0; background: #fff; }
footer { display: none !important; }
"""

with gr.Blocks(title="UNSEEN｜活动共同记忆空间", fill_height=True) as demo:
    gr.HTML(APP_HTML, elem_id="unseen-root")


if __name__ == "__main__":
    demo.launch(css=CSS)
