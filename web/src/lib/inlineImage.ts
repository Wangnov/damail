/**
 * 正文里插入的图片：存成 data: 地址，发送时服务端换成内嵌附件（cid:）。
 * 大图先缩到 1600px 宽、转成 JPEG，避免邮件太大；GIF 保留原图（可能是动图）。
 */
const MAX_WIDTH = 1600;
const KEEP_BYTES = 300 * 1024;
export const MAX_INLINE_BYTES = 8 * 1024 * 1024;

export const isImageFile = (f: File) => /^image\/(png|jpe?g|gif|webp)$/i.test(f.type);

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(blob);
  });

export async function imageToDataUrl(file: File): Promise<string> {
  if (file.size > MAX_INLINE_BYTES && file.type === 'image/gif') throw new Error('too large');
  if (file.type === 'image/gif') return readAsDataUrl(file);
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width <= MAX_WIDTH && file.size <= KEEP_BYTES) return readAsDataUrl(file);
    const scale = Math.min(1, MAX_WIDTH / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d')!;
    // PNG 转 JPEG 时透明部分填白，避免变黑
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) return readAsDataUrl(file);
    if (blob.size > MAX_INLINE_BYTES) throw new Error('too large');
    return readAsDataUrl(blob);
  } finally {
    bitmap.close();
  }
}
