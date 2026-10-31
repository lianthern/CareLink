// Verified against https://docs.worldlabs.ai/api/models on 2026-09-13.
export const WORLD_MODELS = [
  { id: 'marble-1.0-draft', label: '快速草稿', subtitle: 'Draft', description: '先看布局与方向，适合试素材。' },
  { id: 'marble-1.1', label: '标准', subtitle: 'Marble 1.1', description: '日常空间生成，推荐从这里开始。' },
  { id: 'marble-1.1-plus', label: 'Plus', subtitle: 'Marble 1.1 Plus', description: '尝试更大的空间覆盖，适合开阔场景。' },
  { id: 'marble-1.0', label: '经典版', subtitle: 'Marble 1.0', description: '保留旧模型，便于与历史结果比较。', legacy: true }
];
export function worldModelLabel(id) {
  const model = WORLD_MODELS.find(row => row.id === id);
  return model ? `${model.label} · ${model.subtitle}` : '历史任务 · 未记录档位';
}
export function worldPhotoAssessment(photos, mode) {
  const known = photos.filter(p => p.width > 0 && p.height > 0);
  const notes = [], errors = [];
  if (known.length < photos.length) notes.push('提交前会检查照片尺寸。');
  if (known.some(p => Math.min(p.width, p.height) < 1024)) notes.push('有照片的短边不足 1024 像素，建议换用清晰原图。');
  if (mode === 'multi' && known.length > 1) {
    const ratio = known[0].width / known[0].height;
    if (known.some(p => Math.abs(p.width / p.height / ratio - 1) > .01)) errors.push('多图请使用相同的横竖比例。先在相册裁成同一比例，再重新选择；不会自动裁掉画面。');
  }
  if (mode === 'pano' && known.some(p => p.width !== p.height * 2)) errors.push('完整全景需要严格的 2:1 比例。普通宽幅照片或手机横扫长图，请选单图延展。');
  return { notes, errors };
}
