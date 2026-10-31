package com.unseen.harness;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public final class MainActivity extends Activity {
  private static final int CAMERA_PERMISSION_REQUEST = 41;
  private static final String DEFAULT_URL =
      "http://127.0.0.1:4173/web/pano-capture.html?__pano_diag=1";
  private WebView webView;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    WebView.setWebContentsDebuggingEnabled(true);
    webView = new WebView(this);
    setContentView(webView);

    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setMediaPlaybackRequiresUserGesture(false);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);

    webView.setWebViewClient(new WebViewClient());
    webView.setWebChromeClient(new WebChromeClient() {
      @Override
      public void onPermissionRequest(final PermissionRequest request) {
        runOnUiThread(() -> {
          String[] requested = request.getResources();
          for (String resource : requested) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) &&
                checkSelfPermission(Manifest.permission.CAMERA) ==
                    PackageManager.PERMISSION_GRANTED) {
              request.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
              return;
            }
          }
          request.deny();
        });
      }

      @Override
      public boolean onConsoleMessage(ConsoleMessage message) {
        Log.d(
            "UNSEEN_WEB",
            message.messageLevel() + " " + message.message() +
                " @" + message.sourceId() + ":" + message.lineNumber());
        return true;
      }
    });

    if (checkSelfPermission(Manifest.permission.CAMERA) !=
        PackageManager.PERMISSION_GRANTED) {
      requestPermissions(
          new String[] { Manifest.permission.CAMERA },
          CAMERA_PERMISSION_REQUEST);
    } else {
      loadRequestedUrl();
    }
  }

  @Override
  public void onRequestPermissionsResult(
      int requestCode,
      String[] permissions,
      int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    if (requestCode == CAMERA_PERMISSION_REQUEST &&
        grantResults.length > 0 &&
        grantResults[0] == PackageManager.PERMISSION_GRANTED) {
      loadRequestedUrl();
    }
  }

  private void loadRequestedUrl() {
    String url = getIntent().getStringExtra("url");
    webView.loadUrl(url == null || url.isEmpty() ? DEFAULT_URL : url);
  }

  @Override
  protected void onDestroy() {
    if (webView != null) {
      webView.stopLoading();
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }
}
