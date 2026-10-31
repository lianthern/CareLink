// Reused phone compression from deferred publish batch / live-web baseline.
(function(root){
  async function shrinkPhoto(file) {
    let blob = null, resized = false;
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
      resized = scale < 1;
      if (!resized && file.size <= 1200000) { if (bitmap.close) bitmap.close(); return file; }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();
      blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    } catch (_) {
    }
    if (blob && (resized || blob.size < file.size) && blob.size <= 3e6) return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
    if (file.size > 3e6) throw Error(file.name + " 太大，这台手机没能压缩，请换一张照片");
    return file;
  }
root.CareLinkCompress=shrinkPhoto;
})(window);
