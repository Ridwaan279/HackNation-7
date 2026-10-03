/** Read JPEG SOF dimensions without adding an image dependency to the fixture generator. */
export function jpegSize(bytes) {
  if (bytes.readUInt16BE(0) !== 0xffd8) throw new Error('Expected JPEG image')
  let offset = 2
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('Invalid JPEG marker')
    const marker = bytes[offset + 1]
    const length = bytes.readUInt16BE(offset + 2)
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)]
    if (length < 2) break
    offset += 2 + length
  }
  throw new Error('JPEG dimensions unavailable')
}
