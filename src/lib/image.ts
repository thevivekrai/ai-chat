/**
 * Crops a picture to a centred square no bigger than `size` pixels, as a JPEG data URL: what a
 * profile photo needs, at a fraction of the upload size of a phone camera picture.
 */
export async function squareThumbnail(file: Blob, size = 320): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = Math.min(size, side)
  const context = canvas.getContext('2d')
  if (!context) throw new Error("This browser can't prepare the photo.")
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.88)
}
